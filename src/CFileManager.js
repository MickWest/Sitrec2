import {
    areArrayBuffersEqual,
    cleanCSVText,
    disableAllInput,
    enableAllInput,
    ExpandKeyframes,
    getDateTimeFilename,
    getFileExtension,
    isHttpOrHttps,
    parseBoolean,
    versionString
} from "./utils";
import {CNodeArray} from "./nodes/CNodeArray";
import {fileSystemFetch} from "./fileSystemFetch";
import JSZip from "jszip";
import {
    CTrackFile,
    CTrackFileJSON,
    CTrackFileKML,
    CTrackFileMISB,
    CTrackFileSRT,
    CTrackFileSTANAG,
    parseXml
} from "./KMLUtils";
import {CRehoster} from "./CRehoster";
import {CManager} from "./CManager";
import {
    CustomManager,
    Globals,
    guiMenus,
    NodeMan,
    setNewSitchObject,
    setRenderOne,
    Sit,
    Synth3DManager,
    TrackManager
} from "./Globals";
import {fromArrayBuffer as geotiffFromArrayBuffer} from 'geotiff';
import {DragDropHandler} from "./DragDropHandler";
import {parseAirdataCSV} from "./ParseAirdataCSV";
import {parseKLVFile, parseMISB1CSV} from "./MISBUtils";
// Modern CSV parser
import csv from "./utils/CSVParser";
import {asyncCheckLogin} from "./login";
import {par} from "./par";
import {assert} from "./assert.js";
import {textSitchToObject} from "./RegisterSitches";
import {addOptionToGUIMenu, removeOptionFromGUIMenu} from "./lil-gui-extras";
import {
    extractPBACSV,
    isCustom1,
    isFR24CSV,
    isPBAFile,
    parseCustom1CSV,
    parseCustomFLLCSV,
    parseFR24CSV
} from "./ParseCustom1CSV";
import {findColumn, stripDuplicateTimes} from "./ParseUtils";
import {isConsole, isLocal, isServerless, SITREC_APP, SITREC_DOMAIN, SITREC_SERVER} from "./configUtils";
import {TSParser} from "./TSParser";
import {showError} from "./showError";
import {asyncOperationRegistry} from "./AsyncOperationRegistry";
import {EUSToLLA} from "./LLA-ECEF-ENU";
import {projectedBoundsToWGS84} from "./proj4Loader";
import {isAudioOnlyFormat} from "./AudioFormats";
import {extractFeaturesFromFile, isFeaturesCSV} from "./ParseFeaturesCSV";
import {createImageFromArrayBuffer} from "./FileUtils";
import {ModelFiles} from "./nodes/CNode3DObject";
import {LoadingManager} from "./CLoadingManager";
import {convertTiffBufferToPngImage} from "./TIFFUtils";
import {extractFlightClubInfo, flightClubToCSVStrings, isFlightClubJSON} from "./ParseFlightClubJSON";

const trackFileClasses = [
    CTrackFileKML,
    CTrackFileSTANAG,
    CTrackFileSRT,
    CTrackFileJSON,
    CTrackFileMISB,
];


/**
 * The file manager is a singleton that manages all the files.
 * It is a subclass of CManager, which is a simple class that manages a list of objects.
 * The FileManager adds the ability to load files from URLs, and to parse them.
 * It also adds the ability to rehost files, needed for the Celestrack proxy, TLEs,
 * KMLs, and other data files that are dragged in.
 */
export class CFileManager extends CManager {
    /**
     * Creates the FileManager instance.
     * Initializes the raw files array, rehoster, and sets up the GUI if not in console mode.
     */
    constructor() {
        super()
        this.rawFiles = [];
        this.rehostedStarlink = false;

        this.rehoster = new CRehoster();

        if (!isConsole) {
            this.guiFolder = guiMenus.file;
            this.guiFolder.add(this, "newSitch").name("New Sitch").perm().tooltip("Create a new sitch (will reload this page, resetting everything)");


            // the Save and Load buttons should only be available for the custom sitch


            if ((parseBoolean(process.env.SAVE_TO_SERVER) || parseBoolean(process.env.SAVE_TO_S3)) && !isServerless) {

                let serverName = SITREC_DOMAIN;
                if (parseBoolean(process.env.SAVE_TO_S3)) {
                    serverName = process.env.S3_BUCKET + ".s3"
                }

                this.guiServer = this.guiFolder.addFolder("Server (" + serverName + ") "+Globals.userID).perm().open();

                // Server-side rehosting only for logged-in users
                if (Globals.userID > 0) {

                    this.addServerButtons();

                    // this.guiFolder.add(this, "rehostFile").name("Rehost File").perm().tooltip("Rehost a file from your local system. DEPRECATED");
                } else {
                    this.loginButton = this.guiServer.add(this, "loginServer").name("Server Disabled (click to log in)").setLabelColor("#FF8080");
                    this.guiServer.close();
                }
            }

            if (parseBoolean(process.env.SAVE_TO_LOCAL)) {
                // Local save/load is always available for the custom sitch, regardless of login status
                this.guiLocal = this.guiFolder.addFolder("Local").perm().open();
                this.guiLocal.add(this, "saveLocal").name("Save Local Sitch File").perm().tooltip("Save a local version of the sitch, so you can use \"Open Local Sitch Folder\" to load it\nThis must be in the same folder as the files you use like the tracks and the video");
                this.guiLocal.add(this, "openDirectory").name("Open Local Sitch Folder").perm()
                    .tooltip("Open a folder on your local system and load the sitch .json file and any assets in it. If there is more than on .json file you will be prompted to select one ");
            }


            this.guiFolder.add(this, "importFile").name("Import File").perm().tooltip("Import a file (or files) from your local system. Same as dragging and dropping a file into the browser window");

            this.guiFolder.add(this, "resetOrigin").name("Reset Origin").perm();

            if (isLocal) {
                this.guiFolder.add(NodeMan, "recalculateAllRootFirst").name("debug recalculate all").perm();
                this.guiFolder.add(this, "dumpNodes").name("debug dump nodes").perm();
                this.guiFolder.add(this, "dumpNodesBackwards").name("debug dump nodes backwards").perm();
                this.guiFolder.add(this, "dumpRoots").name("debug dump Root notes").perm();
            }

        }
    }

    /**
     * Debug: Dumps the root nodes to the console.
     */
    dumpRoots() {
        console.log("");
        console.log(NodeMan.dumpNodes(true));
    }

    /**
     * Debug: Dumps all nodes to the console.
     */
    dumpNodes() {
        console.log("");
        console.log(NodeMan.dumpNodes());
    }

    /**
     * Debug: Dumps all nodes to the console in reverse order.
     */
    dumpNodesBackwards() {
        console.log("");
        console.log(NodeMan.dumpNodesBackwards());
    }

    /**
     * Resets the origin to the current camera position.
     * Updates Sit.lat and Sit.lon, recalculates the EUS coordinate system,
     * and reloads the situation to apply changes.
     */
    resetOrigin() {
        // First, reset the origin to the current camera position
        // This updates Sit.lat and Sit.lon and recalculates the EUS coordinate system
        // resetGlobalOrigin();


        const lookCamera = NodeMan.get("lookCamera").camera;
        const pos = lookCamera.position;

        const LLA = EUSToLLA(pos);

        // Now serialize the sitch to capture the new origin (Sit.lat, Sit.lon)
        // and then deserialize it in memory to reload everything with the new origin
        const sitchString = CustomManager.getCustomSitchString();

        const sitchObject = textSitchToObject(sitchString);

        console.log("Resetting Origin to " + LLA.x + ", " + LLA.y + ", " + 0);
        sitchObject.lat = LLA.x;
        sitchObject.lon = LLA.y;


        // Create a new CSituation object from the parsed sitch object
        // This effectively "reloads" the sitch with the new origin
        setNewSitchObject(sitchObject);
        
        console.log(`Reset Origin initiated: Sit.lat=${Sit.lat}, Sit.lon=${Sit.lon}`);
    }

    /**
     * Updates the UI based on the current sitch type (Custom or Standard).
     * Shows/hides Local and Server save folders accordingly.
     */
    sitchChanged() {
    // update the UI based on the sitch name
        if (Sit.isCustom) {
            if (parseBoolean(process.env.SAVE_TO_LOCAL)) {
                this.guiLocal.show();
            }
            if (Globals.userID > 0) {
                if ((parseBoolean(process.env.SAVE_TO_SERVER) || parseBoolean(process.env.SAVE_TO_S3)) && !isServerless) {
                    this.guiServer.show();
                }
            }
        } else {
            if (parseBoolean(process.env.SAVE_TO_LOCAL)) {
                this.guiLocal.hide();
            }
            if ((parseBoolean(process.env.SAVE_TO_SERVER) || parseBoolean(process.env.SAVE_TO_S3)) && !isServerless) {
                this.guiServer.hide();
            }
        }

    }

    /**
     * Initiates the server login process.
     * Updates the UI upon successful login.
     */
    loginServer() {
        // asyncCheckLogin().then(() => {
        //     if (Globals.userID > 0) {
        //         this.guiServer.remove(this.loginButton);
        //         this.addServerButtons();
        //     }
        // })

        this.loginAttempt(() => {
            this.loginButton.hide();
            this.addServerButtons()}
        );

    }

    /**
     * Adds server-related buttons (Save, Save As, Open, Delete) to the GUI.
     * Also fetches and populates the list of user's saved sitches from the server.
     */
    addServerButtons() {
        if ((! parseBoolean(process.env.SAVE_TO_SERVER) && !parseBoolean(process.env.SAVE_TO_S3)) || isServerless)
            return;

        this.guiServer.add(this, "saveSitchFromMenu").name("Save").perm().tooltip("Save the current sitch to the server");
        this.guiServer.add(this, "saveSitchAs").name("Save As").perm().tooltip("Save the current sitch to the server with a new name");
        this.guiServer.add(this, "saveWithPermalink").name("Save with Permalink").perm().tooltip("Save the current sitch to the server and get a permalink to share it");

        this.guiServer.open();

        // get the list of files saved on the server
        // this is basically a list of the folders in the user's directory
        let textSitches = [];
        fetch((SITREC_SERVER + "getsitches.php?get=myfiles"), {mode: 'cors'}).then(response => {
            if (response.status !== 200) {
                throw new Error(`Server returned status ${response.status}`);
            }
            return response.text();
        }).then(data => {
//            console.log("Local files: " + data)

            const files = JSON.parse(data);
            // "files" will be and array of arrays, each with a name (index 0) and a date (index 1)
            // we just want the names
            // but first sort them by date, newest first
            files.sort((a, b) => {
                return new Date(b[1]) - new Date(a[1]);
            });


            this.userSaves = files.map((file) => {
                return String(file[0]);
            })


            // add a "-" to the start of the userSaves array, so we can have a blank entry
            this.userSaves.unshift("-");

            // add a selector for loading a file
            this.loadName = this.userSaves[0];
            this.guiLoad = this.guiServer.add(this, "loadName", this.userSaves).name("Open").perm().onChange((value) => {
                this.loadSavedFile(value)
            }).moveAfter("Save with Permalink")
                .tooltip("Load a saved sitch from your personal folder on the server");

            // Create alphabetically sorted version for Open (A-Z)
            this.userSavesAlphabetical = [...this.userSaves]; // copy the array
            // Sort alphabetically, but keep "-" at the beginning
            const dashEntry = this.userSavesAlphabetical.shift(); // remove "-" from beginning
            this.userSavesAlphabetical.sort((a, b) => a.localeCompare(b)); // sort alphabetically
            this.userSavesAlphabetical.unshift(dashEntry); // put "-" back at the beginning

            this.loadNameAlphabetical = this.userSavesAlphabetical[0];
            this.guiLoadAlphabetical = this.guiServer.add(this, "loadNameAlphabetical", this.userSavesAlphabetical).name("Open (A-Z)").perm().onChange((value) => {
                this.loadSavedFile(value)
            }).moveAfter("Open")
                .tooltip("Load a saved sitch from your personal folder on the server (alphabetical order)");

            // this.userVersions = "-";
            // this.guiVersions = this.guiServer.add(this, "userVersions", this.userVersions).name("Versions").perm().onChange((value) => {
            //
            // })

            this.deleteName = this.userSaves[0];
            this.guiDelete = this.guiServer.add(this, "deleteName", this.userSaves).name("Delete").perm().onChange((value) => {
                this.deleteSitch(value)
            }).moveAfter("Open (A-Z)")
                .tooltip("Delete a saved sitch from your personal folder on the server");

            this.versionsList = ["-"];
            this.versionsData = [];
            this.versionName = "-";
            this.guiVersions = this.guiServer.add(this, "versionName", this.versionsList).name("Versions").perm().onChange((value) => {
                this.loadVersion(value);
            }).moveAfter("Delete")
                .tooltip("Load a specific version of the currently selected sitch");

            this.refreshVersions();

        }).catch(error => {
            console.error("Could not fetch user files from server (non-critical):", error.message);
        })

    }

    /**
     * Adds a file entry to the manager. Overrides parent for debugging purposes.
     * @param {string} id - Unique identifier for the file entry
     * @param {*} data - The parsed file data
     * @param {ArrayBuffer} original - The original raw file data
     */
    add(id, data, original) {
        super.add(id, data, original);
    }

    /**
     * Resets the application to a new blank "custom" situation.
     * Reloads the page with ?sitch=custom.
     */
    newSitch() {
        // we just jump to the "custom" sitch, which is a blank sitch
        // that the user can modify and save
        // doing it as a URL to ensure a clean slate
        window.location = SITREC_APP + "?sitch=custom";
    }

    /**
     * Fetches all saved versions of a sitch from the server.
     * @param {string} name - The name of the sitch to get versions for
     * @returns {Promise<Array<{version: string, url: string}>>} Array of version objects with version and url properties
     */
    getVersions(name) {
        return fetch((SITREC_SERVER + "getsitches.php?get=versions&name="+name), {mode: 'cors'}).then(response => {
            if (response.status !== 200) {
                throw new Error(`Server returned status ${response.status}`);
            }
            return response.text();
        }).then(data => {
//            console.log("versions: " + data)
            this.versions = JSON.parse(data) // will give an array of local files
            console.log("Parsed Versions url \n" + this.versions[0].url)


            // this.userVersions = this.versions.map((version) => {
            //     return version.version;
            // });
            //
            // // add a "-" to the start of the userVersions array, so we can have a blank entry
            // this.userVersions.unshift("-");
            //
            // // update this.guiVersions
            //
            // // I think this is not having an effect as we reload the page with the new URL
            // // so we need to build this later, when the page has reloaded
            //
            // this.guiVersions.options = this.userVersions;
            // this.guiVersions.setValue(this.userVersions[0]); // set the first value as the default
            // this.guiVersions.updateDisplay(); // update the display to show the new options
            //

            return this.versions;
        }).catch(error => {
            console.error("Error fetching versions from server:", error);
            throw error; // re-throw so the caller can handle it
        })
    }

    /**
     * Deletes a saved sitch from the server after user confirmation.
     * Updates the GUI dropdowns to remove the deleted entry.
     * @param {string} value - The name of the sitch to delete
     */
    deleteSitch(value) {
        // get confirmation from the user
        if (!confirm("Are you sure you want to delete " + value + " from the server?")) {
            return;
        }


        console.log("Staring to deletet " + value + " from the server");
        this.rehoster.deleteFilePromise(value).then(() => {
            console.log("Deleted " + value)
            this.deleteName = "-";
            if (this.loadName === value) {
                this.loadName = "-";
            }
            if (this.loadNameAlphabetical === value) {
                this.loadNameAlphabetical = "-";
            }
            // the remove calls will also update the GUI
            // to account for the "-" selection
            removeOptionFromGUIMenu(this.guiLoad, value);
            removeOptionFromGUIMenu(this.guiLoadAlphabetical, value);
            removeOptionFromGUIMenu(this.guiDelete, value);
        });

    }

    /**
     * Loads the most recent version of a saved sitch from the server.
     * Fetches the sitch file, parses it, and initializes a new situation with it.
     * @param {string} name - The name of the sitch to load
     */
    loadSavedFile(name) {
        this.loadName = name;
        console.log("Load Local File")
        console.log(this.loadName);

        if (this.loadName === "-") {
            this.updateVersionsDropdown([]);
            return;
        }

        this.getVersions(this.loadName).then((versions) => {
            this.updateVersionsDropdown(versions);
            
            const latestVersion = versions[versions.length - 1].url;
            console.log("Loading " + name + " version " + latestVersion)

            this.loadURL = latestVersion;
            fetch(latestVersion).then(response => response.arrayBuffer()).then(data => {
                console.log("Loaded " + name + " version " + latestVersion)

                const decoder = new TextDecoder('utf-8');
                const decodedString = decoder.decode(data);

                let sitchObject = textSitchToObject(decodedString);

                setNewSitchObject(sitchObject);
            })
        })
    }

    updateVersionsDropdown(versions) {
        if (!this.guiVersions) return;
        
        while (this.versionsList.length > 1) {
            removeOptionFromGUIMenu(this.guiVersions, this.versionsList[this.versionsList.length - 1]);
            this.versionsList.pop();
        }
        
        this.versionsData = versions;
        
        for (let i = versions.length - 1; i >= 0; i--) {
            const v = versions[i];
            const versionFile = v.version;
            const dateMatch = versionFile.match(/(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/);
            let displayName;
            if (dateMatch) {
                displayName = `${dateMatch[1]} ${dateMatch[2]}:${dateMatch[3]}:${dateMatch[4]}`;
            } else {
                displayName = versionFile.replace(/\.sitch\.js$/, '');
            }
            if (i === versions.length - 1) {
                displayName += " (latest)";
            }
            this.versionsList.push(displayName);
            addOptionToGUIMenu(this.guiVersions, displayName, displayName);
        }
        
        this.setVersionFromLoadURL();
    }
    
    setVersionFromLoadURL() {
        if (!this.guiVersions || !this.loadURL || !this.versionsData.length) {
            this.versionName = "-";
            this.guiVersions?.updateDisplay();
            return;
        }
        
        const decodedLoadURL = decodeURIComponent(this.loadURL);
        for (let i = 0; i < this.versionsData.length; i++) {
            const decodedVersionURL = decodeURIComponent(this.versionsData[i].url);
            if (decodedVersionURL === decodedLoadURL) {
                const versionIndex = this.versionsData.length - 1 - i;
                this.versionName = this.versionsList[versionIndex + 1];
                this.guiVersions.updateDisplay();
                return;
            }
        }
        
        this.versionName = "-";
        this.guiVersions.updateDisplay();
    }

    loadVersion(displayName) {
        if (displayName === "-" || !this.versionsData.length) return;
        
        const index = this.versionsList.indexOf(displayName);
        if (index <= 0) return;
        
        const versionIndex = this.versionsData.length - index;
        const versionData = this.versionsData[versionIndex];
        
        if (!versionData) return;
        
        console.log("Loading version: " + versionData.version + " from " + versionData.url);
        
        this.loadURL = versionData.url;
        fetch(versionData.url).then(response => response.arrayBuffer()).then(data => {
            console.log("Loaded version " + versionData.version)

            const decoder = new TextDecoder('utf-8');
            const decodedString = decoder.decode(data);

            let sitchObject = textSitchToObject(decodedString);

            setNewSitchObject(sitchObject);
        })
    }

    /**
     * Prompts the user to enter a name for the sitch via a browser dialog.
     * @returns {Promise<void>} Resolves when user enters a valid name (sets Sit.sitchName), rejects if cancelled
     */
    inputSitchName() {
        return new Promise((resolve, reject) => {
            let sitchName = prompt("Enter a name for the sitch", Sit.sitchName);
            if (sitchName !== null && sitchName !== "") {
                // the server validates the name with: /^[^\/\\<>\x00-\x1f]+$/u
                // so we remove: / \ < > and control characters (0x00-0x1f)
                let validSitchName = sitchName.replace(/[\/\\<>\x00-\x1f]+/g, "_");

                // strip leading and trailing whitespace
                validSitchName = validSitchName.trim();
                // strip off any leading or trailing . or whitespace
                validSitchName = validSitchName.replace(/^[\.\s]+|[\.\s]+$/g, "");


                // if the name is empty, then  error
                if (validSitchName === "") {
                    alert("Invalid sitch name, please try again");
                    reject("Sitch Name Cancelled");
                }
                sitchName = validSitchName;

                Sit.sitchName = sitchName;
                // will need to check if the sitch already exists
                // server side, and if so, ask if they want to overwrite
                console.log("Sitch name set to " + Sit.sitchName)
                resolve();
            } else {
                reject("Sitch Name Cancelled");
            }
        })
    }

    /**
     * GUI menu handler for the "Save" button.
     * Wraps saveSitch() and suppresses errors for GUI use.
     * @returns {Promise<void>}
     */
    saveSitchFromMenu() {
        return this.saveSitch().then(() => {
            console.log("Sitch saved as " + Sit.sitchName);
        }).catch((error) => {
            console.log("Error in saveSitchFromMenu:", error);
        })
    }

    /**
     * Saves the current sitch. Prompts for a name if one isn't set.
     * Updates GUI dropdowns with the new save entry.
     * @param {boolean} [local=false] - If true, saves locally instead of to server
     * @returns {Promise<void>} Resolves when save completes
     */
    saveSitch(local = false) {
        if (Sit.sitchName === undefined) {
            return this.inputSitchName().then(() => {
                return this.saveSitchNamed(Sit.sitchName, local);  // return the Promise here
            }).then(() => {
                if (!local) {
                    addOptionToGUIMenu(this.guiLoad, Sit.sitchName);
                    addOptionToGUIMenu(this.guiLoadAlphabetical, Sit.sitchName);
                    addOptionToGUIMenu(this.guiDelete, Sit.sitchName);
                    return this.refreshVersions();
                }
            }).catch((error) => {
                console.log("Failed to input sitch name:", error);
                // propogate the error
                throw error;
            });
        } else {
            return this.saveSitchNamed(Sit.sitchName, local).then(() => {
                console.log("Sitch saved as " + Sit.sitchName);
                if (!local) {
                    return this.refreshVersions();
                }
            }).catch((error) => {
                console.log("Error in saveSitchNamed:", error);
            })
        }
    }

    refreshVersions() {
        if (!Sit.sitchName) return Promise.resolve();
        return this.getVersions(Sit.sitchName).then((versions) => {
            this.updateVersionsDropdown(versions);
        }).catch((error) => {
            console.warn("Failed to refresh versions:", error);
        });
    }

    /**
     * Saves the sitch and generates a shareable permalink.
     * Displays the permalink in a modal dialog for copying.
     * @returns {Promise<void>}
     */
    saveWithPermalink() {
        return this.saveSitch()
            .then(() => {
            // Wait until the custom link is fully set before calling getPermalink
            return CustomManager.getPermalink();
        }).catch((error) => {
            console.log("Error in saving with permalink:", error);
        });
    }

    /**
     * Saves the sitch with a new name. Clears the current name to force a rename prompt.
     * Restores the original name if cancelled.
     * @returns {Promise<void>}
     */
    saveSitchAs() {
        const lastSitchName = Sit.sitchName;
        Sit.sitchName = undefined;
        return this.saveSitch()
            .then(() => {
                console.log("Sitch saved under a new name.");
            })
            .catch((error) => {
                Sit.sitchName = lastSitchName; // Restore the last sitch name if we cancel
                console.log("Error or Cancel in saveSitchAs:", error);
            }).finally(() => {
                this.guiFolder.close();
            });
    }

    /**
     * Saves the sitch with a specific name. Serializes and uploads to server or creates local download.
     * @param {string} sitchName - The name to save the sitch under
     * @param {boolean} [local=false] - If true, creates a local downloadable file instead of server upload
     * @returns {Promise<void>} Resolves when save is complete
     */
    saveSitchNamed(sitchName, local = false) {

        // and then save the sitch to the server where it will be versioned by data in a folder named for this sitch, for this user
        console.log("Saving sitch as " + sitchName)

        const todayDateTimeFilename = getDateTimeFilename();
        console.log("Unique date time string: " + todayDateTimeFilename)

        const oldPaused = par.paused;
        par.paused = true;
        disableAllInput("SAVING");

        return CustomManager.serialize(sitchName, todayDateTimeFilename, local)
            .then((serialized) => {})
            .catch((error) => {})
            .finally(() => {
                this.guiFolder.close();
                par.paused = oldPaused
                enableAllInput();
            })

    }

    /**
     * GUI menu handler to save the sitch locally.
     * Sets a default name of "Local" if none exists.
     */
    saveLocal() {

        if (Sit.sitchName === undefined) {
            Sit.sitchName = "Local";
        }

        this.saveSitch(true);
    }

    /**
     * Checks if a file needs to be rehosted. A file is unhosted if it's a dynamic link without a static URL.
     * @param {string} id - The file identifier to check
     * @returns {boolean} True if the file needs rehosting
     */
    isUnhosted(id) {
        const f = this.list[id];
        assert(f, `Checking unhosted on missing file, id =${id}`);
        return (f.dynamicLink && !f.staticURL);
    }

    /**
     * Initiates login to Metabunk Xenforo (if not logged in)
     * Opens login window and sets up focus listener to detect completion.
     * @param {Function} [callback] - Function to call after successful login
     * @param {Object} [button] - GUI button to update after login
     * @param {string} [rename="Permalink"] - New name for the button after login
     * @param {string} [color="#FFFFFF"] - New color for the button label after login
     */
    loginAttempt(callback, button, rename = "Permalink", color="#FFFFFF") {
        asyncCheckLogin().then(() => {

            // if we are alreayd logged in, then don't need to open the login window
            if (Globals.userID > 0) {
                if (button !== undefined) {
                    button.name(rename).setLabelColor(color)
                }
                if (callback !== undefined)
                    callback();
                return ;
            }


// open the login URL in a new window
// the redirect takes that tab to the main page
            window.open("https://www.metabunk.org/login?_xfRedirect=https://www.metabunk.org/sitrec/sitrecServer/successfullyLoggedIn.html  ", "_blank");

// When the current window regains focus, we'll check if we are logged in
// and if we are, we'll make the permalink
            window.addEventListener('focus', () => {
                asyncCheckLogin().then(() => {
                    console.log("After Ridirect, Logged in as " + Globals.userID)
                    if (Globals.userID > 0) {
                        // just change the button text
                        if (button !== undefined) {
                            console.log("Changing button name to " + rename)
                            button.name(rename).setLabelColor(color)
                        }
                        if (callback !== undefined) {
                            console.log("Calling callback after login")
                            callback();
                        }
                    }
                });
            });

        })
    }


    /**
     * Create an Export GUI button inside a per-object subfolder, lazily creating folders as needed.
     *
     * Behavior and side effects:
     * - Ensures a top-level "Export" folder exists on the file manager GUI (this.exportFolder).
     * - Ensures the provided object has an attached subfolder (object.exportSubFolder) named by folderName.
     * - Adds a button/controller that triggers object[functionName] when clicked and labels it with exportType.
     * - Returns the created controller so callers can further customize or keep a reference if desired.
     *
     * Notes:
     * - Reuses existing folders if already created, so repeated calls are idempotent w.r.t. folder creation.
     * (i.e. multiple calls for the same object and folderName will not create duplicate folders.)
     * - The object is decorated with an exportSubFolder property for later cleanup via removeExportButton().
     *
     * @param {object} object - The target object that owns the export action method.
     * @param {string} functionName - The exportType of the method on object to invoke when the button is pressed.
     * @param {string} exportType - The visible label for the button in the GUI.
     * @param {string} folderName - The label for the object's subfolder within the top-level Export folder.
     * @returns {*} The GUI controller created by .add(object, functionName).
     */
    makeExportButton(object, functionName, exportType, folderName) {
        if (this.exportFolder === undefined) {
            this.exportFolder = this.guiFolder.addFolder("Export").perm().close();
        }

        // Some common folder names
        if (folderName === "LOSTraverseSelectTrack")
            folderName = "Traversal of the Lines of Sight";

        if (folderName === "JetLOSCameraCenter")
            folderName = "Lines of Sight"


        // we need a subfolder with the title <folderName>
        // decorate the object with an exportSubFolder property
        if (object.exportSubFolder === undefined) {
            object.exportSubFolder = this.exportFolder.addFolder(folderName).perm().close()
                .tooltip("Export options for " + folderName);

        }

        let tooltip = exportType ? exportType : "";

        // see if the function provides a description
        const inspect = object[functionName](true);

        // some legacy sitches (GoFast) have some empty arrays
        // or otherwise not exportable
        if (inspect === null) {
            return null;
        }

        assert(inspect !== undefined, `makeExportButton: Expected inspect info from ${functionName} on ${folderName}`);
        tooltip += inspect.desc;

        if (inspect.csv) {
            const csv = inspect.csv;
            const header = csv.split("\n")[0];
            const row = csv.split("\n")[1];

            tooltip += "\n\nHeader and Example Row:\n" + header;
            tooltip += "\n" + row;
        }

        if (inspect.json) {
            const jsonExample = JSON.stringify(inspect.json, null, 2).substring(0, 200) + "...";
            tooltip += "\nExample JSON: " + jsonExample;
        }

        return object.exportSubFolder.add(object, functionName).name(inspect.desc)
            .tooltip(tooltip);

    }

    /**
     * Removes all export buttons and the subfolder for an object from the Export GUI.
     * @param {Object} object - The object whose export buttons should be removed
     */
    removeExportButton(object) {
        if (this.exportFolder !== undefined) {
            if (object.exportButtons !== undefined) {
                for (let i = 0; i < object.exportButtons.length; i++) {
                    object.exportButtons[i].destroy();
                }
                object.exportButtons = undefined;
            }
            if (object.exportSubFolder !== undefined) {
                object.exportSubFolder.destroy();
                object.exportSubFolder = undefined;
            }
        }
    }

    /**
     * Opens a local directory using the File System Access API.
     * Finds and loads a .json or .js sitch file from the directory.
     * If multiple sitch files exist, prompts user to select one.
     * @async
     */
    async openDirectory() {
        try {
            // 1) Prompt for the directory
            this.directoryHandle = await window.showDirectoryPicker();

            // 2) Collect all .json or .js files
            const validEntries = [];
            for await (const entry of this.directoryHandle.values()) {
                if (
                    entry.kind === "file" &&
                    (entry.name.endsWith(".json") || entry.name.endsWith(".js"))
                ) {
                    validEntries.push(entry);
                }
            }

            // 3) If exactly one file was found, use that. Otherwise, prompt for a file.
            if (validEntries.length === 1) {
                // We know exactly which file to use:
                this.localSitchEntry = validEntries[0];
                console.log("Using sole matching file:", this.localSitchEntry.name);
            } else {
                // If there's multiple or none, we ask the user to pick one file.
                console.log(
                    `Found ${validEntries.length} matching files. Prompting user to pick one.`
                );

                // The showOpenFilePicker approach can be configured to “startIn” the directory handle (if supported).
                const [fileHandle] = await window.showOpenFilePicker({
                    startIn: this.directoryHandle, // Experimental in some browsers
                    multiple: false,
                    types: [
                        {
                            description: "JSON or JS files",
                            accept: {
                                "application/json": [".json"],
                                "text/javascript": [".js"]
                            }
                        }
                    ]
                });

                this.localSitchEntry = fileHandle;
                console.log("User selected file:", this.localSitchEntry.name);
            }

            // 4) Use your file handle (e.g., re-host, read content, etc.)
            // Example: call your existing method to process it
            this.checkForNewLocalSitch();

        } catch (err) {
            console.warn("openDirectory() error or cancelled", err.name, err.message);
            this.guiFolder.close();
        }
    }


    /**
     * Checks if the local sitch file has changed since last load and parses it if so.
     * Used to detect external edits to the sitch file.
     * @async
     */
    async checkForNewLocalSitch() {

        // load the local sitch and see if it has changed
        const file = await this.localSitchEntry.getFile();
        this.localSitchBuffer = await file.arrayBuffer();
//        console.log("CHECKING CONTENTS OF Local Sitch " + file.name);

        if (this.lastLocalSitchBuffer === undefined ||
            !areArrayBuffersEqual(this.lastLocalSitchBuffer, this.localSitchBuffer)) {
            this.lastLocalSitchBuffer = this.localSitchBuffer;
            this.parseResult(file.name, this.localSitchBuffer);
        }

        // This was for when we were continually loading the local sitch
        // and seeing if it changed, but it's not needed now
        // as we only load it once
    //    setTimeout(() => this.checkForNewLocalSitch(), 500);
    }


    /**
     * Opens a file selector dialog and processes each selected file.
     * Supports multiple file selection for various file types (video, audio, images, data files).
     * @param {Function} processFile - Callback function to process each selected File object
     */
    selectAndLoadLocalFile(processFile) {
        // Create an input element
        const inputElement = document.createElement('input');

        // Set its type to 'file'
        inputElement.type = 'file';
        
        // Allow multiple file types including videos, audio and images for better mobile support
        inputElement.accept = 'video/*,audio/*,image/*,.kml,.kmz,.csv,.json,.geojson,.sitch,.txt,.xml,.srt,.ts,.m2ts,.mts,.zip,.mp3,.m4a,.aac,.wav,.ogg,.flac,.webm,.aif,.aiff,.caf';
        
        // Allow multiple files
        inputElement.multiple = true;

        // Listen for changes on the input element
        inputElement.addEventListener('change', (event) => {
            const files = event.target.files;
            if (files && files.length > 0) {
                // Process each selected file
                for (let i = 0; i < files.length; i++) {
                    processFile(files[i]);
                }
            }

            // Remove the input element after use
            inputElement.remove();

        });
        
        // Add to body to ensure proper interaction on iOS
        document.body.appendChild(inputElement);

        // Trigger a click event on the input element
        inputElement.click();

    }

    // Direct file rehosting is deprecated
    // files are now rehosted as needed when they are used in the sitch
    // rehostFile() {
    //     this.selectAndLoadLocalFile( (file) => {
    //         const reader = new FileReader();
    //
    //         // Listen for the 'load' event on the FileReader
    //         reader.addEventListener('load', () => {
    //
    //             this.rehoster.rehostFile(file.name, reader.result).then(rehostResult => {
    //                 console.log("Imported File Rehosted as " + rehostResult);
    //                 // display an alert with the new URL so the user can copy it
    //                 //alert(rehostResult);
    //                 createCustomModalWithCopy(rehostResult)();
    //
    //             });
    //
    //         });
    //
    //         // Read the file as an array buffer (binary data)
    //         reader.readAsArrayBuffer(file);
    //     })
    // }

    /**
     * GUI menu handler for importing files. Opens file selector and processes files via DragDropHandler.
     */
    importFile() {
        this.selectAndLoadLocalFile( (file) => {
            DragDropHandler.uploadDroppedFile(file)
        })
    }


    /**
     * Private map of currently loading promises to prevent duplicate loads.
     * Keyed by filename.
     */
    #loadingPromises = new Map();

    /**
     * Loads and parses an asset file, adding it to the manager.
     * Handles caching, deduplication of concurrent requests, and URL resolution.
     * For programmatic loading where the caller handles the result (does NOT call handleParsedFile).
     * 
     * Filename prefixes:
     * - "!" prefix marks as dynamic link (needs rehosting on save)
     * - "data/" prefix is stripped automatically
     * 
     * @param {string} filename - Path, URL, or local filename to load
     * @param {string} [id] - Unique identifier for storage (defaults to filename)
     * @returns {Promise<{filename: string, parsed: *, dataType: string}>} Parsed asset data
     */
    loadAsset(filename, id) {

        assert(filename, "Filename is undefined or null");

        // if it starts with data/ then strip that off
        if (filename.startsWith("data/")) {
            filename = filename.substring(5);
        }

        var dynamicLink = false;
        if (filename.startsWith("!")) {
            filename = filename.substring(1);
            dynamicLink = true;
        }

        // If we don't have an id, then the id used will be the filename
        // so see if already loaded
        if (id === undefined) {
            if (this.exists(filename)) {
                return Promise.resolve(this.get(filename));
            }
            id = filename; // Fallback to use filename as id if id is undefined
        }

        // If the asset is already loaded, return it immediately
        if (this.exists(id)) {
            return Promise.resolve({filename: filename, parsed: this.list[id].data});
        }

        // Check if this file is already being loaded (by filename)
        // If so, return the existing promise to avoid duplicate loading
        const loadingKey = `${filename}`;
        if (this.#loadingPromises.has(loadingKey)) {
            console.log(`Asset ${filename} is already being loaded, reusing existing promise`);
            return this.#loadingPromises.get(loadingKey).then(parsedAsset => {
                // If the requested ID is different from the one being loaded,
                // we'll need to add a new entry with the requested ID
                if (parsedAsset.id !== id && !this.exists(id)) {
                    this.add(id, this.list[parsedAsset.id].data, this.list[parsedAsset.id].original);
                    this.list[id].dynamicLink = this.list[parsedAsset.id].dynamicLink;
                    this.list[id].staticURL = this.list[parsedAsset.id].staticURL;
                    this.list[id].dataType = this.list[parsedAsset.id].dataType;
                    this.list[id].filename = filename;
                }
                return {filename: filename, parsed: this.list[id].data};
            });
        }

        // Check if this file has already been loaded with a different ID
        var existingId = null;
        this.iterate((key, parsed) => {
            const f = this.list[key];
            if (f.filename === filename) {
                existingId = key;
                console.log(`File ${filename} already loaded with ID ${key}, requested with ID ${id}`);
            }
        });
        
        // If the file exists with a different ID, create a new entry with the requested ID
        if (existingId) {
            this.add(id, this.list[existingId].data, this.list[existingId].original);
            this.list[id].dynamicLink = this.list[existingId].dynamicLink;
            this.list[id].staticURL = this.list[existingId].staticURL;
            this.list[id].dataType = this.list[existingId].dataType;
            this.list[id].filename = filename;
            return Promise.resolve({filename: filename, parsed: this.list[id].data});
        }


        // // if we are going to try to load it,
        // assert(!this.exists(id), "Asset " + id + " already exists");

        let loadingPromise;
        const loadingId = `asset-${id}-${Date.now()}`;
        LoadingManager.registerLoading(loadingId, filename, "Asset");

        if (!filename.includes("/")) {
            assert(this.directoryHandle !== undefined, `No directory handle for local file ${filename}`);
            loadingPromise = this.directoryHandle.getFileHandle(filename).then(fileHandle => {
                return fileHandle.getFile().then(file => {
                    return file.arrayBuffer().then(arrayBuffer => {
                        LoadingManager.completeLoading(loadingId);
                        return this.parseResult(filename, arrayBuffer, null);
                    });
                });
            }).catch(error => {
                LoadingManager.completeLoading(loadingId);
                throw error;
            });
        } else {
            // if not a local file, then it's a URL
            // either a dynamic link (like to the current Starlink TLE) or a static link
            // so fetch it and parse it

            var isUrl = isHttpOrHttps(filename);
            if (!isUrl) {
                // legacy sitches have videos specified as: "../sitrec-videos/public/2 - Gimbal-WMV2PRORES-CROP-428x428.mp4"
                // and in that case it's relative to SITREC_APP wihtout the data folder
                if (filename.startsWith("../sitrec-videos/")) {
                    filename = SITREC_APP + filename;
                } else {
                    // if it's not a url, then redirect to the data folder
                    //filename = "./data/" + filename;
                    filename = SITREC_APP + "data/" + filename;
                }
            } else {
                // if it's a URL, we need to check if it's got a "localhost" in it
                // Regardless of whether we are on local or not
                // add the SITREC_DOMAIN to the start of the URL
                // this is a patch to keep older localhost files compatible with the deployed
                // and with the new local.metabunk.org
                if (filename.startsWith("https://localhost/")) {
                    filename = SITREC_DOMAIN + '/' + filename.slice(18);
                    console.log("Redirecting debug local URL to " + filename);
                }

                // same for https://local.metabunk.org/
                if (!isLocal && filename.startsWith("https://local.metabunk.org/")) {
                    filename = SITREC_DOMAIN + '/' + filename.slice(27);
                    console.log("Redirecting debug local URL to " + filename);
                }

                // and the specified process.env.LOCALHOST
                if (!isLocal && filename.startsWith(process.env.LOCALHOST)) {
                    filename = SITREC_DOMAIN + '/' + filename.slice(process.env.LOCALHOST.length);
                    console.log("Redirecting debug local URL to " + filename);
                }
            }

            Globals.parsing++;

            var bufferPromise = null;
            let fetchOperationId = null; // Track for cleanup
            if(!isUrl && isConsole) {
                // read the asset from the local filesystem if this is not running inside a browser
                bufferPromise = import('node:fs')
                .then(fs => {
                    return fs.promises.readFile(filename);
                });
            } else {
                // URL-encode the path components (especially filenames with spaces)
                // Split URL into base and query string if present
                const [urlBase, queryString] = filename.split('?');


                let encodedUrlBase = urlBase;

                // WE DON'T DO THIS AS IT MESSES WITH KNOWN GOOD URLS ON S3
                // // Encode each path segment while preserving slashes
                // encodedUrlBase = urlBase.split('/').map(segment => {
                //     // Don't encode protocol part (http:, https:) or empty segments
                //     if (segment.endsWith(':') || segment === '') return segment;
                //     return encodeURIComponent(segment);
                // }).join('/');



                
                // Reconstruct with query string if it existed
                const encodedFilename = queryString ? `${encodedUrlBase}?${queryString}` : encodedUrlBase;
                
                // add a version string to the filename, so we can force a reload when a new version is deployed
                // the filename is the URL to the file, so we can just add a query string
                // unless it already has one, in which case we add a &v=1
                const versionExtension = (encodedFilename.includes("?") ? "&" : "?") + "v=1" + versionString;
                
                // Create AbortController for this fetch and register it
                const fetchController = new AbortController();
                fetchOperationId = asyncOperationRegistry.registerAbortable(
                    fetchController,
                    'fetch',
                    `loadAsset: ${filename}`
                );

                // If this is an S3 URL then do NOT use the version extension
                const isS3Url = encodedFilename.includes("s3.amazonaws.com") || encodedFilename.includes(".s3.");
                const fetchUrl = isS3Url ? encodedFilename : encodedFilename + versionExtension;

                // Use custom fetch wrapper that supports File System Access API
                bufferPromise = fileSystemFetch(fetchUrl, { signal: fetchController.signal })
                .then(response => {
                    if (!response.ok) {
                        throw new Error('Network response was not ok');
                    }
                    return response.arrayBuffer(); // Return the promise for the next then()
                })
                .finally(() => {
                    // CRITICAL: Unregister the fetch operation when complete (success or error)
                    if (fetchOperationId !== null) {
                        asyncOperationRegistry.unregister(fetchOperationId);
                    }
                })
            }

            Globals.pendingActions++;

            if (filename.toLowerCase().endsWith('.ts')) {
                loadingPromise = bufferPromise
                    .then(arrayBuffer => {
                        console.log(`Special handling for .TS file load: ${filename} (id: ${id})`);
                        Globals.parsing--;
                        Globals.pendingActions--;
                        LoadingManager.completeLoading(loadingId);
                        return this.parseResult(id, arrayBuffer, filename);
                    })
                    .catch(error => {
                        Globals.parsing--;
                        console.log(`There was a problem loading .TS file ${filename}: ${error.message}`);
                        Globals.pendingActions--;
                        LoadingManager.completeLoading(loadingId);
                        this.#loadingPromises.delete(loadingKey);
                        throw error;
                    });
            } else {

                var original = null;
                loadingPromise = bufferPromise
                    .then(arrayBuffer => {
                        // parseAsset always returns a promise
//                        console.log(`<<< loadAsset() Loading Finished: ${filename} (id: ${id})`);

                        // always store the original
                        original = arrayBuffer;

                        const assetPromise = this.parseAsset(filename, id, arrayBuffer);
                        return assetPromise;
                    })
                    .then(parsedAsset => {
                        // if an array is returned, we just assume it's the first one
                        // because we are adding by id here, not by filename
                        // so if it's a zipped asset, it should only be one
                        if (Array.isArray(parsedAsset)) {
                            assert(parsedAsset.length === 1, "Zipped IDed asset contains multiple files")
                            parsedAsset = parsedAsset[0]
                        }

                        // We now have a full parsed asset in a {filename: filename, parsed: parsed} structure
                        this.add(id, parsedAsset.parsed, original); // Add the loaded and parsed asset to the manager
                        this.list[id].dynamicLink = dynamicLink;
                        this.list[id].staticURL = null; // indicates it has not been rehosted
                        this.list[id].dataType = parsedAsset.dataType; // Store the data type of the asset
                        if (isHttpOrHttps(filename) && !dynamicLink) {
                            // if it's a URL, and it's not a dynamic link, then we can store the URL as the static URL
                            // indicating we don't want to rehost this later.
                            this.list[id].staticURL = filename;
                        }
                        this.list[id].filename = filename;
                        if (id === "starLink") {
                            console.log("Flagging initial starlink file");
                            this.list[id].isTLE = true;
                        }

                        Globals.parsing--;
                        Globals.pendingActions--;
                        LoadingManager.completeLoading(loadingId);

                        parsedAsset.id = id;
                        return parsedAsset;
                    })
                    .catch(error => {
                        Globals.parsing--;
                        console.log(`There was a problem loading ${filename}: ${error.message}`);
                        Globals.pendingActions--;
                        LoadingManager.completeLoading(loadingId);

                        this.#loadingPromises.delete(loadingKey);
                        throw error;
                    });
            }
        }

        // Register the loading promise with the async operation registry
        asyncOperationRegistry.registerPromise(
            loadingPromise,
            'file-load',
            `${id}: ${filename}`
        );
        
        // Store the loading promise in the map and return it
        this.#loadingPromises.set(loadingKey, loadingPromise);
        
        // Add a finally handler to clean up the loading promise map
        loadingPromise.finally(() => {
            this.#loadingPromises.delete(loadingKey);
        });
        
        return loadingPromise;
    }


    /**
     * Detects if a file is a TLE (Two/Three-Line Element) file based on extension.
     * Currently assumes all .txt and .tle files are TLE files. (also .2le and .3le)
     * (Note this matche $allowed_extensions in sitrecServer/proxy.php)
     * @param {string} filename - The filename to check
     * @returns {boolean} True if the file appears to be a TLE file
     */
    detectTLE(filename) {
        const fileExt = getFileExtension(filename);
        const isTLE = (fileExt === "txt" || fileExt === "tle" || fileExt === "2le" || fileExt === "3le");
        return isTLE;
    }

    /**
     * Entry point for user-loaded files (drag/drop, local folder, import).
     * Parses the raw buffer, adds to FileManager, and routes to appropriate subsystem via handleParsedFile.
     * Unlike loadAsset, this DOES call handleParsedFile for automatic routing.
     * 
     * @param {string} filename - The name of the file (used as both filename and id)
     * @param {ArrayBuffer} result - The raw file data
     * @param {string|null} newStaticURL - Static URL if file was loaded from a permanent location
     * @returns {Promise<Array<{filename: string, parsed: *, dataType: string}>>} Array of parsed results
     */
    parseResult(filename, result, newStaticURL) {
        console.log("parseResult: Parsing " + filename)
        return this.parseAsset(filename, filename, result)
            .then(async parsedResult => {


                let isMultiple = false;
                // parsing an asset file can return a single result,
                // or an array of one or more results (like with a zip file)
                // for simplicity, if it's a single result we wrap it in an array
                if (!Array.isArray(parsedResult)) {
                    parsedResult = [parsedResult]
                } else {
                    // it is an array, so we need to make an entry for the original
                    this.remove(filename); // allow reloading.
                    this.add(filename, result, result)
                    const fileManagerEntry = this.list[filename];
                    fileManagerEntry.dynamicLink = true; // we DO want to rehost the original
                    fileManagerEntry.staticURL = newStaticURL;

                    // for multiple files, we don't want to keep the original static link
                    // we set it to null, so we don't try to include it loadedFiles
                    newStaticURL = null;

                    fileManagerEntry.filename = filename;
                    fileManagerEntry.dataType = "archive";
                    isMultiple = true;
                }

                for (const x of parsedResult) {

                    // if multi, do we even need to add them?
                    // I think so.

                    this.remove(x.filename); // allow reloading.
                    this.add(x.filename, x.parsed, result)
                    const fileManagerEntry = this.list[x.filename];
                    fileManagerEntry.dynamicLink = !isMultiple;
                    fileManagerEntry.filename = x.filename;
                    fileManagerEntry.staticURL = newStaticURL;
                    fileManagerEntry.dataType = x.dataType;
                    fileManagerEntry.isMultiple = isMultiple;

                    const parsedFile = x.parsed;
                    const filename = x.filename;

                    NodeMan.suspendRecalculate()
                    await this.handleParsedFile(filename, parsedFile);
                    NodeMan.unsuspendRecalculate();

                }
                console.log("parseResult: DONE Parse " + filename)
                setRenderOne(true);
                return parsedResult
            })
    }

    /**
     * Routes a parsed file to the appropriate subsystem based on file type and dataType.
     * Called by parseResult after parsing. Handles:
     * - TLE files → NightSkyNode
     * - Track files (KML, CSV, SRT, KLV, JSON, XML) → TrackManager
     * - Sitch files → setNewSitchObject (reloads app)
     * - Az/El/FOV/Heading CSVs → customAzElController, fovSwitch, headingController
     * - Video/audio → video node
     * - Images → video node (as single-frame video)
     * - GLB models → targetObject
     * 
     * @param {string} filename - The name of the file
     * @param {*} parsedFile - The parsed file data (type varies by file format)
     */
    async handleParsedFile(filename, parsedFile) {
        console.log("handleParsedFile: Handling parsed file " + filename)


        setRenderOne(2)

        const fileExt = getFileExtension(filename);

        if (filename.split('.').length === 1) {
//            console.log("Skipping handleParseFile, as no file extension for " + filename+" assuming it's an ID");
            return;
        }

        const fileManagerEntry = this.list[filename];

        assert(fileManagerEntry !== undefined, "handleParsedFile: FileManager entry not found for " + filename);
        assert(fileManagerEntry.dataType !== undefined, "handleParsedFile: FileManager entry dataType not set for " + filename);

        // ensure we don't parse the file twice.
        if (fileManagerEntry.handled)   {
            console.error("handleParsedFile: File already handled for " + filename+", skipping");
            return;
        }
        fileManagerEntry.handled = true;

        // first we check for special files that need special handling
        if (fileManagerEntry.dataType === "FEATURES") {
            // Extract features and mark the file to not be saved
            extractFeaturesFromFile(parsedFile);
            // Mark this file as transient - don't save it during serialization
            fileManagerEntry.skipSerialization = true;
            return;
        }

        // Handle FlightClub JSON files - convert to CSV tracks
        if (fileManagerEntry.dataType === "flightclub") {
            this.handleFlightClubJSON(filename, parsedFile, fileManagerEntry);
            return;
        }

        // Handle image files that were imported as video source
        if (fileManagerEntry.dataType === "videoImage") {
            // If a multi-video restore is in progress, skip this - loadVideoFromEntry will handle it
            // Calling makeImageVideo here would trigger loadedCallback and corrupt the restore sequence
            if (NodeMan.exists("video")) {
                const videoNode = NodeMan.get("video");
                if (videoNode.pendingVideoRestore) {
                    console.log(`[CFileManager] Skipping video image restore for "${filename}" - pendingVideoRestore active`);
                    return;
                }
            }

            // Load image and set as video source
            // Use .original which contains the ArrayBuffer (not .data which is the parsed Image object)
            const buffer = fileManagerEntry.original;
            if (buffer) {
                const ext = getFileExtension(filename).toLowerCase();
                const mimeType = ext === 'png' ? 'image/png' :
                                ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
                                ext === 'gif' ? 'image/gif' :
                                ext === 'webp' ? 'image/webp' : 'image/png';
                const blob = new Blob([buffer], { type: mimeType });
                const blobURL = URL.createObjectURL(blob);

                const img = new Image();
                img.onload = () => {
                    if (NodeMan.exists("video")) {
                        const videoNode = NodeMan.get("video");
                        videoNode.makeImageVideo(filename, img);
                        videoNode.imageFileID = filename;
                        console.log(`Restored video image "${filename}" (${img.width}x${img.height})`);
                    }
                };
                img.src = blobURL;
            }
            return;
        }

        // Handle image files for ground overlays - just create blobURL
        // The overlay itself is restored via C3DSynthManager serialization
        if (fileManagerEntry.dataType === "groundOverlayImage") {
            // Use .original which contains the ArrayBuffer (not .data which is the parsed Image object)
            const buffer = fileManagerEntry.original;
            if (buffer && !fileManagerEntry.blobURL) {
                const ext = getFileExtension(filename).toLowerCase();
                const mimeType = ext === 'png' ? 'image/png' :
                                ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
                                ext === 'gif' ? 'image/gif' :
                                ext === 'webp' ? 'image/webp' : 'image/png';
                const blob = new Blob([buffer], { type: mimeType });
                fileManagerEntry.blobURL = URL.createObjectURL(blob);
                console.log(`Created blobURL for ground overlay image "${filename}"`);
            }
            return;
        }

        // if it's a CSV, the first check if it contails AZ and EL
        // if it does, then we want to send it to the customAzElController node
        if (fileExt === "csv") {

            // bit of patch, if the type has not been set
            // check if it contains az, el, zoom, fov, heading columns
            if ( fileManagerEntry.dataType === "AZIMUTH" || fileManagerEntry.dataType === "ELEVATION" || fileManagerEntry.dataType === "HEADING" || fileManagerEntry.dataType === "FOV" || fileManagerEntry.dataType === "Unknown" || fileManagerEntry.dataType === undefined) {
                const azCol = findColumn(parsedFile, "Az", true);
                const elCol = findColumn(parsedFile, "El", true);
                const zoomCol = findColumn(parsedFile, "Zoom", true);
                const fovCol = findColumn(parsedFile, "FOV", true);
                const headingCol = findColumn(parsedFile, "Heading", true);


                if (azCol !== -1 || elCol !== -1 || zoomCol !== -1 || fovCol !== -1 || headingCol !== -1) {

                    // get the firs col header before we slice them off
                    const firstColumnHeader = parsedFile[0][0].toLowerCase();
                    // remove the first row (headers)
                    parsedFile = parsedFile.slice(1);

                    // we expect frame numbers in the first column
                    // if the head is "time" then we expect time in seconds
                    // so convert it to frame numbers
                    if (firstColumnHeader === "time") {
                        // convert the time to frame numbers
                        const fps = Sit.fps;
                        parsedFile.forEach(row => {
                            if (row[0] !== undefined) {
                                row[0] = Math.round(row[0] * fps);
                            }
                        });
                    }


                    // it's a CSV with az, el, zoom, and/or fov
                    // so we want to send it to the customAzElController node

                    const azElController = NodeMan.get("customAzElController", false)
                    if (azElController) {
                        if (azCol !== -1) {
                            azElController.setAzFile(parsedFile, azCol);
                        }

                        if (elCol !== -1) {
                            azElController.setElFile(parsedFile, elCol);
                        }


                    }

                    // handle FOV/Zoom columns if present - create CNodeArray and add to fovSwitch
                    if (fovCol !== -1 || zoomCol !== -1) {
                        const fovSwitch = NodeMan.get("fovSwitch", false);
                        if (fovSwitch) {
                            // Use FOV column if present, otherwise use Zoom column
                            const dataCol = fovCol !== -1 ? fovCol : zoomCol;
                            const columnName = fovCol !== -1 ? "FOV" : "Zoom";

                            // Create expanded keyframes array (step-wise, not smoothed)
                            const fovArray = ExpandKeyframes(parsedFile, Sit.frames, 0, dataCol, true);


                            // TODO: modify filemanager to get original filenames from static links
                            // like https://sitrec.s3.us-west-2.amazonaws.com/99999999/fov-727f880234d0cc8281a09e75c2b3f5aa.csv


                            // Create CNodeArray with filename as ID
                            const fovNodeId = fileManagerEntry.filename.replace(/\.[^/.]+$/, "") + "_" + columnName;

                            if (NodeMan.exists(fovNodeId)) {
                                NodeMan.unlinkDisposeRemove(fovNodeId);
                            }

                            const fovNode = new CNodeArray({id: fovNodeId, array: fovArray});

                            // Add or replace the option in the fovSwitch
                            fovSwitch.replaceOption(fovNodeId, fovNode);

                            // Select this new FOV source
                            fovSwitch.selectOption(fovNodeId);
                        }
                    }

                    // handle heading column if present
                    if (headingCol !== -1) {
                        const headingController = NodeMan.get("customHeadingController", false)
                        if (headingController) {
                            headingController.setHeadingFile(parsedFile, headingCol);
                            headingController.recalculate();
                        }
                    }

                    // handled the AZ, EL, ZOOM, FOV, and/or HEADING CSV file, so
                    return;
                }
                // if we get here, then we don't have az and el columns

            } else {
                // for known CSV files, we assume they are in the right format
                // strip the first row
                // as it's the header
                // and we don't want to send it to the customAzElController
                // Skip slicing for CTrackFile instances (already processed)
                if (!(parsedFile instanceof CTrackFile)) {
                    parsedFile = parsedFile.slice(1);
                }
            }
        }


        // very rough figuring out what to do with it
        // TODO: multiple TLEs, Videos, images.
        if (fileManagerEntry.dataType === "tle") {

            // remove any existing TLE (most likely the current Starlink, bout could be the last drag and drop file)
            this.deleteIf(file => file.isTLE);

            fileManagerEntry.isTLE = true;
            NodeMan.get("NightSkyNode").replaceTLE(parsedFile)
        } else {
            let isATrack = false;
            let isASitch = false;
            
            // Use polymorphic doesContainTrack() for all CTrackFile types (KML, XML, SRT, etc.)
            if (parsedFile instanceof CTrackFile) {
                isATrack = parsedFile.doesContainTrack();
            } else if (fileManagerEntry.dataType === "json"
                || ( fileExt === "csv" && fileManagerEntry.dataType !== "Unknown")
                || fileExt === "klv") {
                isATrack = true;
            }

            if (fileManagerEntry.dataType === "sitch") {
                isASitch = true;
            }

            if (isATrack) {
                TrackManager.addTracks([filename], true)
                // Call extractObjects for all CTrackFile types (no-op for most, extracts features for KML)
                if (parsedFile instanceof CTrackFile) {
                    parsedFile.extractObjects()
                }
                return
            } else if (isASitch) {
                // parsedFile is a sitch text def
                // make a copy of the string (as we might be removing all the files)
                // and set it as the new sitch text
                let copy = parsedFile.slice();
                // if it's an arraybuffer, convert it to a sitch object
                if (copy instanceof ArrayBuffer) {
                    const decoder = new TextDecoder('utf-8');
                    const decodedString = decoder.decode(copy);
                    copy = textSitchToObject(decodedString);
                }
                setNewSitchObject(copy)
                return;
            } else if (fileExt === "glb") {
                // it's a model, so we can replace the model used in targetModel
                // we have filename, and we can just set
                ModelFiles[filename] = {file: filename};
                if (NodeMan.exists("targetObject")) {
                    const target = NodeMan.get("targetObject");
                    target.modelOrGeometry = "model"
                    target.selectModel = filename;
                    target.rebuild();
                    // woudl also need to add it to the gui
                }
                return;


            }

            // Handle CTrackFile types that don't contain tracks but may have other objects
            if (parsedFile instanceof CTrackFile) {
                parsedFile.extractObjects()
                return;
            }

            // is it a video file (like H.264 streams from TS files)?
            if (fileManagerEntry.dataType === "video") {
                console.log("Video data detected: " + filename);
                if (!NodeMan.exists("video")) {
                    console.warn("No video node found to load video data");
                    return;
                }

                const videoNode = NodeMan.get("video");

                // Check if it's an H.264 stream
                if (fileExt === "h264") {
                    console.log("H.264 stream detected, attempting to load with specialized handler");
                    const blob = new Blob([parsedFile], { type: 'video/h264' });
                    const file = new File([blob], filename, { type: 'video/h264' });
                    videoNode.uploadFile(file, true);
                } 
                // Check if it's an audio file (M4A, MP3, etc.)
                else if (fileExt === "m4a" || fileExt === "mp3") {
                    console.log("Audio file detected: " + filename);
                    const mimeType = fileExt === "mp3" ? 'audio/mpeg' : 'audio/mp4';
                    const blob = new Blob([parsedFile], { type: mimeType });
                    const file = new File([blob], filename, { type: mimeType });
                    videoNode.uploadFile(file, true);
                }
                // Check if it's a regular video file (MP4, MOV, WEBM, AVI)
                else if (fileExt === "mp4" || fileExt === "mov" || fileExt === "webm" || fileExt === "avi") {
                    console.log("Video file detected: " + filename);
                    const mimeType = `video/${fileExt === "mov" ? "quicktime" : fileExt}`;
                    const blob = new Blob([parsedFile], { type: mimeType });
                    const file = new File([blob], filename, { type: mimeType });
                    videoNode.uploadFile(file, true);
                }
                else {
                    console.warn("Unknown video format for: " + filename);
                }
                return;
            }

            // is it a KMZ overlay image? Skip video handling - these are for ground overlays
            if (fileManagerEntry.dataType === "kmzImage") {
                console.log("Skipping video handling for KMZ overlay image: " + filename);
                return;
            }

            // is it an image?
            if (fileExt === "jpg" || fileExt === "jpeg" || fileExt === "png" || fileExt === "gif" || fileManagerEntry.dataType === "image") {
                const isTiff = fileExt === "tif" || fileExt === "tiff";
                
                if (isTiff) {
                    try {
                        const choice = await DragDropHandler.showImageChoiceDialog(filename);
                        if (choice === 'video') {
                            if (NodeMan.exists("video")) {
                                NodeMan.get("video").makeImageVideo(filename, parsedFile, true);
                            }
                        } else if (choice === 'overlay') {
                            await this.createGroundOverlayFromImage(filename, parsedFile);
                        }
                    } catch (e) {
                        console.log("Image import cancelled");
                    }
                    return;
                }
                
                if (!NodeMan.exists("video")) {
                    console.warn("No video node found to load video file");
                    return;
                }
                NodeMan.get("video").makeImageVideo(filename, parsedFile, true);
                return;
            }

            // is it a GeoTIFF?
            if (fileManagerEntry.dataType === "geotiff") {
                const { buffer, bounds } = parsedFile;
                this.createGroundOverlayFromGeoTIFF(filename, buffer, bounds);
                // Mark the original .tif file to skip serialization
                // We only want to serialize the converted PNG, not the original GeoTIFF
                fileManagerEntry.skipSerialization = true;
                return;
            }

            console.warn("Unhandled file type: " + fileExt + " for " + filename);

        }
    }

    async createGroundOverlayFromGeoTIFF(filename, buffer, bounds) {
        const baseName = filename.replace(/\.[^.]+$/, '');
        const fileID = `geotiff_${baseName}_${Date.now()}`;
        
        const tiff = await geotiffFromArrayBuffer(buffer);
        const image = await tiff.getImage();
        const width = image.getWidth();
        const height = image.getHeight();
        const rasters = await image.readRasters();
        
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(width, height);
        
        const numBands = rasters.length;
        const photometricInterpretation = image.fileDirectory.PhotometricInterpretation;
        const extraSamples = image.fileDirectory.ExtraSamples;
        const hasAlpha = extraSamples && (extraSamples[0] === 1 || extraSamples[0] === 2);
        
        for (let i = 0; i < width * height; i++) {
            if (numBands >= 3) {
                imageData.data[i * 4] = rasters[0][i];
                imageData.data[i * 4 + 1] = rasters[1][i];
                imageData.data[i * 4 + 2] = rasters[2][i];
                imageData.data[i * 4 + 3] = (numBands >= 4 && hasAlpha) ? rasters[3][i] : 255;
            } else {
                const val = rasters[0][i];
                imageData.data[i * 4] = val;
                imageData.data[i * 4 + 1] = val;
                imageData.data[i * 4 + 2] = val;
                imageData.data[i * 4 + 3] = 255;
            }
        }
        ctx.putImageData(imageData, 0, 0);
        
        const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const pngBuffer = await pngBlob.arrayBuffer();
        const blobURL = URL.createObjectURL(pngBlob);
        
        const pngFilename = baseName + '.png';
        this.remove(fileID);
        this.add(fileID, pngBuffer, pngBuffer);
        this.list[fileID].dynamicLink = true;
        this.list[fileID].staticURL = null;
        this.list[fileID].filename = pngFilename;
        this.list[fileID].dataType = "image";
        
        Synth3DManager.addOverlay({
            name: NodeMan.getUniqueID(baseName, 18),
            north: bounds.north,
            south: bounds.south,
            east: bounds.east,
            west: bounds.west,
            rotation: 0,
            imageURL: blobURL,
            imageFileID: fileID,
            gotoOnCreate: true,
            lockShape: true,
        });
        CustomManager.saveGlobalSettings();
        console.log(`Created ground overlay from GeoTIFF: ${filename} (fileID: ${fileID})`);
    }

    async createGroundOverlayFromImage(filename, img) {
        const baseName = filename.replace(/\.[^.]+$/, '');
        
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        
        const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const blobURL = URL.createObjectURL(pngBlob);
        
        const lookCamera = NodeMan.get("lookCamera");
        const pos = lookCamera.p(par.frame);
        const centerLLA = EUSToLLA(pos);
        
        const offset = 0.005;
        
        const overlay = Synth3DManager.addOverlay({
            name: NodeMan.getUniqueID(baseName, 18),
            north: centerLLA.x + offset,
            south: centerLLA.x - offset,
            east: centerLLA.y + offset,
            west: centerLLA.y - offset,
            rotation: 0,
            imageURL: blobURL,
        });
        
        if (overlay) {
            overlay.setEditMode(true);
            console.log(`Created ground overlay from image: ${filename}`);
        }
    }

    handleFlightClubJSON(filename, jsonData, fileManagerEntry) {
        console.log("Processing FlightClub JSON: " + filename);

        fileManagerEntry.skipSerialization = true;

        const csvResults = flightClubToCSVStrings(jsonData);
        const missionInfo = extractFlightClubInfo(jsonData);
        const baseName = filename.replace(/\.[^.]+$/, '');

        const trackFilenames = [];

        csvResults.forEach((result) => {
            const csvFilename = `${baseName}-${result.stageName.replace(/\s+/g, '_')}.csv`;
            const encoder = new TextEncoder();
            const csvBuffer = encoder.encode(result.csvString).buffer;

            const parsed = csv.toArrays(result.csvString);
            const misbData = parseCustom1CSV(parsed);
            const trackFile = new CTrackFileMISB(stripDuplicateTimes(misbData));

            this.add(csvFilename, trackFile, csvBuffer);
            this.list[csvFilename].filename = csvFilename;
            this.list[csvFilename].dataType = "trackfile";
            this.list[csvFilename].dynamicLink = true;

            trackFilenames.push(csvFilename);
            console.log(`Created track file "${result.stageName}" as ${csvFilename}`);
        });

        TrackManager.addTracks(trackFilenames, true);

        if (NodeMan.exists("notesView")) {
            const notesView = NodeMan.get("notesView");
            const existingNotes = notesView.notesText || "";
            const separator = existingNotes ? "\n\n" : "";
            notesView.notesText = existingNotes + separator + missionInfo;
            if (notesView.textArea) {
                notesView.textArea.value = notesView.notesText;
            }
            notesView.show(true);
        }

        setRenderOne();
        console.log(`FlightClub JSON processed: ${csvResults.length} tracks created`);
    }

    /**
     * Low-level parser that converts a raw ArrayBuffer to typed data based on file extension.
     * Recursively handles container formats:
     * - .ts files: Uses TSParser to extract streams, calls parseAsset for each
     * - .zip/.kmz files: Unzips via JSZip, calls parseAsset for each extracted file
     * 
     * Returns parsed data with dataType indicating the format:
     * - text, tle, csv, kml, xml, json, sitch, video, image, glb, bin, etc.
     * 
     * @param {string} filename - The name of the file being parsed
     * @param {string} id - The identifier for the asset (used for storage)
     * @param {ArrayBuffer} buffer - The binary data of the file
     * @param {Object} [metadata=null] - Optional metadata (e.g., FPS from TS parser)
     * @returns {Promise<{filename: string, parsed: *, dataType: string}|Array>} Parsed asset or array for archives
     */
    parseAsset(filename, id, buffer, metadata = null) {
//        console.log("CFileManager::parseAsset - " + filename + " for id: " + id + " buffer size: " + buffer.byteLength);

        // Check if it's a TS file first, these require special handling
        // as they can contain multiple streams inside them
        if (filename.toLowerCase().endsWith('.ts')) {
            // Use the TSParser to handle TS files, which will call back to parseAsset for each stream
            return TSParser.parseTSFile(filename, id, buffer, (streamFilename, streamId, streamData, streamMetadata) => {
                console.log("Detected TS Stream: " + streamFilename + " for id: " + streamId + "")
                return this.parseAsset(streamFilename, streamId, streamData, streamMetadata);
            });
        }
        
        // similarly, if it's a zip file, then we need to extract the files
        // and then parse them
        // checking for a zip file by both extension and magic number in the first four bytes

        let isZip = false;
        // Check if the filename ends with .zip or .kmz
        if (filename.endsWith('.zip') || filename.endsWith('.kmz')) {
            isZip = true;
        }
        // files zipped on the server are not always .zip at this point
        // so we need to check the first few bytes of the file
        const byteView = new Uint8Array(buffer);
        if (byteView[0] === 0x50 && byteView[1] === 0x4B && byteView[2] === 0x03 && byteView[3] === 0x04) {
            isZip = true;
        }

        // If it's a zip file, then we need to unzip it
        if (isZip) {
            // Create a new instance of JSZip
            const zip = new JSZip();
            // Load the zip file
            return zip.loadAsync(buffer)
                .then(async (zipContents) => {
                    const allFiles = Object.keys(zipContents.files).filter(f => {
                        const entry = zipContents.files[f];
                        return !entry.dir && !f.includes('__MACOSX') && !f.includes('._');
                    });
                    
                    // For KMZ files, first parse KML to find referenced images
                    const kmlFiles = allFiles.filter(f => f.toLowerCase().endsWith('.kml'));
                    const referencedImages = new Set();
                    
                    if (filename.toLowerCase().endsWith('.kmz') && kmlFiles.length > 0) {
                        for (const kmlFile of kmlFiles) {
                            const kmlBuffer = await zipContents.files[kmlFile].async('arraybuffer');
                            const decoder = new TextDecoder('utf-8');
                            const kmlText = decoder.decode(kmlBuffer);
                            // Extract all href values from the KML
                            const hrefMatches = kmlText.matchAll(/<href>([^<]+)<\/href>/gi);
                            for (const match of hrefMatches) {
                                const href = match[1].trim();
                                // Only add if it looks like an image file
                                if (/\.(png|jpg|jpeg|gif|webp)$/i.test(href)) {
                                    referencedImages.add(href);
                                    console.log("KMZ: Found referenced image in KML:", href);
                                }
                            }
                        }
                    }
                    
                    // Process images referenced by KML first - store them in FileManager
                    const imageFiles = allFiles.filter(f => {
                        const baseName = f.split('/').pop();
                        return referencedImages.has(baseName);
                    });
                    
                    for (const imgFile of imageFiles) {
                        const baseName = imgFile.split('/').pop();
                        
                        // Skip if this image was already loaded (e.g., from serialized files)
                        if (this.kmzImageMap && this.kmzImageMap[baseName]) {
                            console.log(`KMZ: Skipping image ${baseName}, already loaded`);
                            continue;
                        }
                        
                        const imgBuffer = await zipContents.files[imgFile].async('arraybuffer');
                        const ext = baseName.split('.').pop().toLowerCase();
                        const mimeType = ext === 'png' ? 'image/png' : 
                                        ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
                                        ext === 'gif' ? 'image/gif' : 'image/webp';
                        
                        const blob = new Blob([imgBuffer], { type: mimeType });
                        const blobURL = URL.createObjectURL(blob);
                        
                        // Store in FileManager with the href as the key
                        const fileID = `kmz_${filename}_${baseName}`;
                        this.remove(fileID);
                        this.add(fileID, imgBuffer, imgBuffer);
                        this.list[fileID].dynamicLink = true;
                        this.list[fileID].staticURL = null;
                        this.list[fileID].filename = baseName;
                        this.list[fileID].dataType = "kmzImage";
                        this.list[fileID].blobURL = blobURL;
                        this.list[fileID].kmzHref = baseName;
                        
                        // Also store a mapping from the original href to the blob URL
                        if (!this.kmzImageMap) this.kmzImageMap = {};
                        this.kmzImageMap[baseName] = blobURL;
                        
                        console.log(`KMZ: Stored image ${baseName} with blobURL ${blobURL}`);
                    }
                    
                    // Now process non-image files (KML, etc.) normally
                    const nonImageFiles = allFiles.filter(f => {
                        const baseName = f.split('/').pop();
                        return !referencedImages.has(baseName);
                    });
                    
                    const filePromises = nonImageFiles.map(zipFilename => {
                        const zipEntry = zipContents.files[zipFilename];
                        return zipEntry.async('arraybuffer')
                            .then(unzippedBuffer => {
                                let prefixedFilename = filename + "_" + zipFilename;
                                console.log("Unzipped file: " + prefixedFilename + " for id: " + id + " buffer size: " + unzippedBuffer.byteLength);
                                return this.parseAsset(prefixedFilename, id, unzippedBuffer);
                            })
                            .catch(err => {
                                console.error("Error parsing unzipped file " + zipFilename + ":", err);
                                throw err;
                            });
                    });
                    
                    return Promise.all(filePromises);
                })
                .catch(error => {
                    console.error('Error unzipping the file:', error);
                    showError('Error unzipping the file:', error);
                });
        } else {


            // get the extension from the filename
            // this is normally just the part after the last dot
            // but for Proxied files, we default to .txt (for TLE files)
            var fileExt = this.deriveExtension(filename);

            var parsed;  // set to true if we successfully parse the file
            var prom; // set to a promise if the parsing is async

            const decoder = new TextDecoder("utf-8"); // replace "utf-8" with detected encoding

            let dataType = "unknown";

            switch (fileExt.toLowerCase()) {
                case "txt": {
                    var text = decoder.decode(buffer);
                    const txtType = detectTXTType(text);
                    if (txtType === "PBA") {
                        text = extractPBACSV(text);
                        parsed = csv.toArrays(text);
                        const custom1Misb = parseCustom1CSV(parsed);
                        if (Sit.isCustom) {
                            parsed = new CTrackFileMISB(stripDuplicateTimes(custom1Misb));
                        } else {
                            parsed = new CTrackFileMISB(custom1Misb);
                        }
                        dataType = "trackfile";
                    } else {
                        parsed = text;
                        dataType = "tle";
                    }
                    break;
                }
                case "tle":
                    parsed = decoder.decode(buffer);
                    dataType = "tle";
                    break;
                case "dat": // for bsc5.dat, the bright star catalog
                    parsed = decoder.decode(buffer);
                    dataType = "dat";
                    break;
                case "klv": {
                    const klvMisb = parseKLVFile(buffer);
                    parsed = new CTrackFileMISB(klvMisb);
                    dataType = "trackfile";
                    break;
                }
                case "jpg":
                case "jpeg":
                    prom = createImageFromArrayBuffer(buffer, 'image/jpeg')
                    dataType = "image";
                    break
                case "gif":
                    prom = createImageFromArrayBuffer(buffer, 'image/gif')
                    dataType = "image";
                    break
                case "png":
                    prom = createImageFromArrayBuffer(buffer, 'image/png')
                    dataType = "image";
                    break
                case "tif":
                case "tiff":
                    prom = (async () => {
                        try {
                            const tiff = await geotiffFromArrayBuffer(buffer);
                            const image = await tiff.getImage();
                            const bbox = image.getBoundingBox();
                            if (bbox && bbox.length === 4) {
                                const [west, south, east, north] = bbox;
                                if (west !== 0 || south !== 0 || east !== image.getWidth() || north !== image.getHeight()) {
                                    const geoKeys = image.getGeoKeys();
                                    const geographicType = geoKeys?.GeographicTypeGeoKey;
                                    const projectedType = geoKeys?.ProjectedCSTypeGeoKey;
                                    
                                    const isWGS84Geographic = geographicType === 4326 && !projectedType;
                                    const isValidLatLon = north >= -90 && north <= 90 && 
                                                          south >= -90 && south <= 90 &&
                                                          east >= -180 && east <= 180 && 
                                                          west >= -180 && west <= 180;
                                    
                                    let finalBounds = { north, south, east, west };
                                    
                                    if (!isWGS84Geographic && !isValidLatLon) {
                                        if (projectedType) {
                                            try {
                                                finalBounds = await projectedBoundsToWGS84(projectedType, west, south, east, north);
                                                console.log(`Converted EPSG:${projectedType} bounds to WGS84:`, finalBounds);
                                            } catch (e) {
                                                console.warn(`GeoTIFF has unsupported projected CRS (EPSG:${projectedType}): ${e.message}`);
                                                dataType = "image";
                                                return convertTiffBufferToPngImage(buffer);
                                            }
                                        } else {
                                            console.warn(`GeoTIFF has unknown CRS (Geographic: ${geographicType}). ` +
                                                `Bounds [${west}, ${south}, ${east}, ${north}] are not valid lat/lon.`);
                                            dataType = "image";
                                            return convertTiffBufferToPngImage(buffer);
                                        }
                                    }
                                    
                                    dataType = "geotiff";
                                    return {
                                        buffer: buffer,
                                        bounds: finalBounds,
                                        width: image.getWidth(),
                                        height: image.getHeight()
                                    };
                                }
                            }
                        } catch (e) {
                            console.log("GeoTIFF parsing failed, treating as regular image:", e.message);
                        }
                        dataType = "image";
                        return convertTiffBufferToPngImage(buffer);
                    })();
                    break
                case "webp":
                    prom = createImageFromArrayBuffer(buffer, 'image/webp')
                    dataType = "image";
                    break
                case "heic":
                    dataType = "image";
                    prom = createImageFromArrayBuffer(buffer, 'image/heic')
                    break
                case "csv": {
                    const buffer2 = cleanCSVText(buffer)
                    var text = decoder.decode(buffer);

                    parsed = csv.toArrays(text);
                    dataType = detectCSVType(parsed)
                    if (dataType === "Unknown") {
                        parsed.shift(); // remove the header, legacy file type handled in specific code
                    } else if (dataType === "Airdata") {
                        const airdataMisb = parseAirdataCSV(parsed);
                        parsed = new CTrackFileMISB(airdataMisb);
                        dataType = "trackfile";
                    } else if (dataType === "MISB_FULL") {
                        const misbFullData = parseMISB1CSV(parsed);
                        parsed = new CTrackFileMISB(misbFullData);
                        dataType = "trackfile";
                    } else if (dataType === "MISB1") {
                        const csvMisb = parseMISB1CSV(parsed);
                        if (Sit.isCustom) {
                            parsed = new CTrackFileMISB(stripDuplicateTimes(csvMisb));
                        } else {
                            parsed = new CTrackFileMISB(csvMisb);
                        }
                        dataType = "trackfile";
                    } else if (dataType === "CUSTOM1") {
                        const custom1Misb = parseCustom1CSV(parsed);
                        if (Sit.isCustom) {
                            parsed = new CTrackFileMISB(stripDuplicateTimes(custom1Misb));
                        } else {
                            parsed = new CTrackFileMISB(custom1Misb);
                        }
                        dataType = "trackfile";
                    } else if (dataType === "CUSTOM_FLL") {
                        const customFllMisb = parseCustomFLLCSV(parsed);
                        if (Sit.isCustom) {
                            parsed = new CTrackFileMISB(stripDuplicateTimes(customFllMisb));
                        } else {
                            parsed = new CTrackFileMISB(customFllMisb);
                        }
                        dataType = "trackfile";
                    } else if (dataType === "FR24CSV") {
                        const fr24Misb = parseFR24CSV(parsed);
                        if (Sit.isCustom) {
                            parsed = new CTrackFileMISB(stripDuplicateTimes(fr24Misb));
                        } else {
                            parsed = new CTrackFileMISB(fr24Misb);
                        }
                        dataType = "trackfile";
                    }

                    break;
                }
                case "kml":
                case "ksv":
                case "xml": {
                    const xmlParsed = parseXml(decoder.decode(buffer));
                    parsed = this.detectTrackFile(filename, xmlParsed);
                    if (parsed) {
                        dataType = "trackfile";
                    } else {
                        console.warn("No trackfile handler found for XML/KML file: " + filename);
                        dataType = "unknown";
                        parsed = xmlParsed;
                    }
                    break;
                }
                case "glb":             // 3D models in glTF binary format
                    dataType = "glb";
                    parsed = buffer;
                    break;
                case "bin":             // for binary files like BSC5 (the Yale Bright Star Catalog)
                    dataType = "bin";
                    parsed = buffer;
                    break;
                case "sitch.js":        // custom text sitch files
                    dataType = "sitch";
                    parsed = buffer;
                    break;
                case "srt": { // SRT is a subtitle file, but is used by DJI drones to store per-frame coordinates.
                    const srtText = decoder.decode(buffer);
                    parsed = this.detectTrackFile(filename, srtText);
                    if (parsed) {
                        dataType = "trackfile";
                    } else {
                        console.warn("No trackfile handler found for SRT file: " + filename);
                        dataType = "unknown";
                        parsed = srtText;
                    }
                    break;
                }
                case "json": {
                    const jsonParsed = JSON.parse(decoder.decode(buffer))
                    if (jsonParsed.isASitchFile) {
                        dataType = "sitch";
                        parsed = buffer;
                    } else if (isFlightClubJSON(jsonParsed)) {
                        dataType = "flightclub";
                        parsed = jsonParsed;
                    } else {
                        parsed = this.detectTrackFile(filename, jsonParsed);
                        if (parsed) {
                            dataType = "trackfile";
                        } else {
                            dataType = "json";
                            parsed = jsonParsed;
                        }
                    }
                    break;
                }
                case "h264":
                    // Raw H.264 elementary stream from TS file
                    // These need special handling as they lack MP4 container structure
                    // For now, treat as video data and let the video system handle it
                    dataType = "video";
                    parsed = buffer;
                    console.log("Parsed H.264 stream: " + filename + " (" + buffer.byteLength + " bytes)");
                    break;

                case "m2v":
                    // MPEG-2 video elementary stream from TS file
                    // Note: MPEG-2 support is limited and may not work in all browsers
                    dataType = "video";
                    parsed = buffer;
                    // Attach metadata (FPS, dimensions) if available from TS parser
                    if (metadata) {
                        parsed.fps = metadata.fps;
                        parsed.width = metadata.width;
                        parsed.height = metadata.height;
                        console.log("Parsed MPEG-2 stream: " + filename + " (" + buffer.byteLength + " bytes)" + 
                                    (metadata.fps ? ` @ ${metadata.fps.toFixed(2)} fps` : '') +
                                    (metadata.width && metadata.height ? ` ${metadata.width}x${metadata.height}` : ''));
                    } else {
                        console.log("Parsed MPEG-2 stream: " + filename + " (" + buffer.byteLength + " bytes)");
                    }
                    break;

                case "mp4":
                case "mov":
                case "webm":
                case "avi":
                    // Video files - treat as video
                    dataType = "video";
                    parsed = buffer;
                    console.log("Parsed video: " + filename + " (" + buffer.byteLength + " bytes)");
                    break;

                default:
                    // Check if it's an audio format (mp3, wav, ogg, flac, webm, aac, m4a, etc.)
                    if (isAudioOnlyFormat(filename)) {
                        dataType = "video";  // Treat as video so it can be handled by CVideoAudioOnly
                        parsed = buffer;
                        console.log("Parsed audio file: " + filename + " (" + buffer.byteLength + " bytes)");
                        break;
                    }
                    
                    // theoretically we could inspect the file contents and then reload it...
                    // but let's trust the extensions
                    //assert(0, "Unhandled extension " + fileExt + " for " + filename)
                    console.warn("Unhandled extension " + fileExt + " for " + filename)
                    return Promise.resolve({filename: filename, parsed: buffer, dataType: dataType});
            }

//            console.log("parseAsset: DONE Parse " + filename)

            // if a promise then promise to wrap the result of that in a structure
            if (prom !== undefined) {
                return prom.then(parsed => {
                    return {
                        filename: filename, parsed: parsed, dataType: dataType
                    }
                })
            }

            // otherwise just return the results wrapped in a resolved promise
            return Promise.resolve({filename: filename, parsed: parsed, dataType: dataType});
        }
    }

    /**
     * Detects which CTrackFile subclass can handle the given data.
     * Iterates through registered trackFileClasses and returns an instance of the first
     * class that can handle the data, or null if none can.
     * @param {string} filename - The filename being parsed
     * @param {*} data - The parsed data (object for XML/KML/JSON, string for SRT)
     * @returns {CTrackFile|null} An instance of the matching CTrackFile subclass, or null
     */
    detectTrackFile(filename, data) {
        const matchingClasses = trackFileClasses.filter(TrackFileClass => TrackFileClass.canHandle(filename, data));
        assert(matchingClasses.length <= 1, 
            `Multiple trackfile handlers matched for ${filename}: ${matchingClasses.map(c => c.name).join(', ')}`);
        if (matchingClasses.length === 1) {
            return new matchingClasses[0](data);
        }
        return null;
    }

    /**
     * Derives the file extension from a filename, with special handling for proxy URLs.
     * Proxy URLs (proxy.php, proxyStarlink.php) are treated as .txt (TLE files).
     * @param {string} filename - The filename or URL to extract extension from
     * @returns {string} The file extension (without dot)
     */
    deriveExtension(filename) {
        var fileExt;
        if (filename.startsWith(SITREC_SERVER + "proxy.php")) {
            fileExt = "txt"
        } else if (filename.startsWith(SITREC_SERVER + "proxyStarlink.php")) {
            fileExt = "txt"
        } else {
            fileExt = getFileExtension(filename);
        }
        return fileExt
    }

    /**
     * Uploads all dynamic (non-static) files to the server for permanent hosting.
     * Called before saving a sitch to ensure all local/temporary files have static URLs.
     * Sets staticURL on each file entry after successful upload.
     * @param {boolean} [rehostVideo=false] - If true, also rehost the video file
     * @returns {Promise<void[]>} Resolves when all rehosting is complete
     */
    rehostDynamicLinks(rehostVideo = false) {
        const rehostPromises = [];
        const todayDateStr = new Date().toISOString().split('T')[0];

        // first check for video rehosting
        if (rehostVideo) {
            if (NodeMan.exists("video")) {
                const videoNode = NodeMan.get("video")
                
                videoNode.updateCurrentVideoEntry();
                
                const videosToRehost = videoNode.videos && videoNode.videos.length > 0 
                    ? videoNode.videos 
                    : [{ fileName: videoNode.fileName, staticURL: videoNode.staticURL, videoData: videoNode.videoData }];
                
                console.log("[CFileManager.rehostDynamicLinks] Rehosting", videosToRehost.length, "video(s)");
                
                for (let i = 0; i < videosToRehost.length; i++) {
                    const entry = videosToRehost[i];
                    const vData = entry.videoData;
                    
                    if (!vData) {
                        console.log(`[CFileManager.rehostDynamicLinks] Video ${i}: no videoData, skipping`);
                        continue;
                    }
                    
                    const videoDroppedData = vData.videoDroppedData;
                    if (!videoDroppedData) {
                        console.log(`[CFileManager.rehostDynamicLinks] Video ${i}: no videoDroppedData, skipping`);
                        continue;
                    }
                    
                    if (entry.staticURL) {
                        console.log(`[CFileManager.rehostDynamicLinks] Video ${i}: already has staticURL, skipping`);
                        continue;
                    }
                    
                    let rehostFilename = entry.fileName;
                    if (rehostFilename.length > 100) {
                        const extension = getFileExtension(rehostFilename);
                        rehostFilename = rehostFilename.substring(0, 100) + "-" + todayDateStr + "." + extension;
                        console.warn(`Rehosting video ${i} with cropped filename: ${rehostFilename}`);
                    }
                    
                    console.log(`[CFileManager.rehostDynamicLinks] Starting rehost for video ${i}: ${rehostFilename}`);
                    const entryRef = entry;
                    rehostPromises.push(this.rehoster.rehostFile(rehostFilename, videoDroppedData).then((staticURL) => {
                        console.log("VIDEO REHOSTED AS PROMISED: " + staticURL)
                        entryRef.staticURL = staticURL;
                        if (entryRef === videosToRehost[videoNode.currentVideoIndex]) {
                            videoNode.staticURL = staticURL;
                        }
                    }))
                }
            }
        }


        Object.keys(this.list).forEach(key => {
            const f = this.list[key];
            
            // Skip files marked for no serialization (e.g., FEATURES files)
            if (f.skipSerialization) {
                console.log("Skipping serialization for: " + key);
                return;
            }
            
            if (f.dynamicLink && !f.staticURL) {


                var rehostFilename = f.filename;

                // If we rehost a TLE file, then need to set the rehostedStarlink flag
                // first check for the special case of a "starLink" file
                // If we get here then that can only be the dynamic proxy version
                // so calculate a filename and rehost
                if (key === "starLink") {
                    this.rehostedStarlink = true;
                    rehostFilename = key + "-" + todayDateStr + "." + this.deriveExtension(f.filename)
                    console.log("this.rehostedStarlink set as REHOSTING starLink as " + rehostFilename)
                } else {
                    // if it's just a TLE, then we are still going to rehost a TLE
                    // but it will be one dragged in
                    // but can just use the filename as normal
                    if (f.isTLE) {
                        this.rehostedStarlink = true;
                        console.log("this.rehostedStarlink set as REHOSTING TLE " + rehostFilename)
                    }
                }

                assert(rehostFilename !== undefined, "Rehost filename is undefined for key " + key);

                console.log("Dynamic Rehost: " + rehostFilename + " length=" + f.original.byteLength + " staticURL=" + f.staticURL)
                const fileKey = key;
                const fileEntry = f;
                const rehostPromise = this.rehoster.rehostFile(rehostFilename, f.original).then((staticURL) => {
                    console.log("AS PROMISED: " + staticURL)
                    fileEntry.staticURL = staticURL;
                    
                    if (fileEntry.dataType === "videoImage" && NodeMan.exists("video")) {
                        const videoNode = NodeMan.get("video");
                        const videoEntry = videoNode.videos?.find(v => v.imageFileID === fileKey);
                        if (videoEntry) {
                            console.log(`[rehostDynamicLinks] Updated video entry staticURL for image ${fileKey}`);
                            videoEntry.staticURL = staticURL;
                            if (videoNode.imageFileID === fileKey) {
                                videoNode.staticURL = staticURL;
                            }
                        }
                    }
                }).catch((error) => {
                    console.error("Rehost failed for " + rehostFilename + ":", error);
                    throw error; // Re-throw to propagate to Promise.all
                })
                console.log("Pushing rehost promise for " + rehostFilename);
                rehostPromises.push(rehostPromise)
            }
        })
        return Promise.all(rehostPromises);
    }

    /**
     * Disposes all file entries and clears the raw files array.
     * Called when resetting or reloading the application.
     */
    disposeAll() {
        this.rawFiles = [];
        super.disposeAll()
    }

}

/**
 * Detects the type of a TXT file based on content patterns.
 * Assumes TLE unless detected as something else.
 * @param {string} text - The text content of the file
 * @returns {string} Type identifier: "PBA" or "TLE" (default)
 */
export function detectTXTType(text) {
    if (isPBAFile(text)) {
        return "PBA";
    }
    return "TLE";
}

/**
 * Detects the type of a CSV file based on header row patterns.
 * @param {Array<Array<string>>} csv - 2D array representation of CSV [row][col]
 * @returns {string} Type identifier: "Airdata", "MISB1", "CUSTOM1", "CUSTOM_FLL", "FR24CSV", 
 *                   "AZIMUTH", "ELEVATION", "HEADING", "FOV", "FEATURES", or "Unknown"
 */
export function detectCSVType(csv) {

    // Airdata is DJI airdata export CSV files from https://airdata.com/
    if (csv[0][0] === "time(millisecond)" && csv[0][1] === "datetime(utc)") {
        return "Airdata"
    }


    // MISB_FULL is the exported format from CNodeMISBDataTrack.exportMISBCSV
    // It has all MISB columns with headers matching the MISB field names exactlyThe
    // First columns are: unknown, Checksum, UnixTimeStamp, MissionID, ...
    if (csv[0][1] === "Checksum" && csv[0][2] === "UnixTimeStamp" && csv[0][3] === "MissionID") {
        return "MISB_FULL";
    }

    // MISB1 is some exported verions of MISB KLV as CSV
    // There are a couple of variants of this
    // but basically it's going to have some of the standard MISB columns in it
    // and possibly some extra columns at the start, depending on what tool exported it

    if (csv[0][0] === "DPTS" && csv[0][1] === "Security:") {
        // The DPTS and Security: columns are the first two columns of the MISB1 CSV sample header used for misb2 test sitch
        // not sure if this is actually common
        return "MISB1"
    }

    // a more normal MISB file will have a header row with the column names
    // and one of them will be "Sensor Latitude"
    // so return true if "Sensor Latitude" is in the first row
    // also return true for "SensorLatitude" as we want to allow the headers to be the tag ids as well as the full tag names
    if (csv[0].includes("Sensor Latitude") || csv[0].includes("SensorLatitude")) {
        return "MISB1";
    }


    // Just Frame, Latitude, Longitude for custom FLL files
    if (csv[0][0].toLowerCase() === "frame" && csv[0][1].toLowerCase() === "latitude" && csv[0][2].toLowerCase() === "longitude") {
        return "CUSTOM_FLL"
    }

    // CUSTOM1, is a more generic custom CSV format
    // that has things like time, lat, lon, alt, and other things in various configuration
    // see the isCustom1() function in CFileManger.js for details
    if (isCustom1(csv)) {
        return "CUSTOM1";
    }

    if (isFR24CSV(csv)) {
        return "FR24CSV";
    }

    if ((csv[0][0].toLowerCase() === "frame" || csv[0][0].toLowerCase() === "time")
        && csv[0][1].toLowerCase() === "az") {
        return "AZIMUTH"
    }

    if ((csv[0][0].toLowerCase() === "frame" || csv[0][0].toLowerCase() === "time")
        && csv[0][1].toLowerCase() === "el") {
        return "ELEVATION"
    }

    if ((csv[0][0].toLowerCase() === "frame" || csv[0][0].toLowerCase() === "time")
        && csv[0][1].toLowerCase() === "heading") {
        return "HEADING"
    }

    if ((csv[0][0].toLowerCase() === "frame" || csv[0][0].toLowerCase() === "time")
        && (csv[0][1].toLowerCase() === "fov" || csv[0][1].toLowerCase() === "zoom")) {
        return "FOV"
    }

    if (isFeaturesCSV(csv)) {
        return "FEATURES"
    }

    // only give an error warning for custom, as some sitches have custom code to use
    // specific columns of CSV files.
    // Skip warning for legacy sitches with setup functions - they handle their own CSVs (e.g. Gimbal)
    if (Sit.isCustom && typeof Sit.setup !== 'function') {
        showError("Unhandled CSV type detected.  Please add to detectCSVType() function.")
    }
    return "Unknown";
}


/**
 * Waits until all file parsing operations are complete (Globals.parsing === 0).
 * Also processes any queued drag/drop files before waiting.
 * Polls every 100ms until parsing is complete.
 * @async
 * @returns {Promise<void>}
 */
export async function waitForParsingToComplete() {
    DragDropHandler.checkDropQueue();
    console.log("Waiting for parsing to complete... Globals.parsing = " + Globals.parsing);
    // Use a Promise to wait
    await new Promise((resolve, reject) => {
        // Function to check the value of Globals.parsing
        function checkParsing() {
            if (Globals.parsing === 0) {
                console.log("DONE: Globals.parsing = " + Globals.parsing);
                resolve(); // Resolve the promise if Globals.parsing is 0
            } else {
                // If not 0, wait a bit and then check again
                setTimeout(checkParsing, 100); // Check every 100ms, adjust as needed
                console.log("Still Checking, Globals.parsing = " + Globals.parsing)
            }
        }

        // Start checking
        checkParsing();
    });
    console.log("Parsing complete!");
}


