import {FileManager, Globals, gui, guiShowHide, NodeMan, setRenderOne, Sit, UndoManager} from "./Globals";
import {par} from "./par";
import {closeFullscreen, openFullscreen} from "./utils";
import {Vector3} from "three";
import {EventManager} from "./CEventManager";

/* Usage examples

KeyMan.key("space").onDown((e, keyInfo) => console.log("Space pressed!"))
KeyMan.key("w").onUp(() => console.log("W released!"))
if (KeyMan.key("shift").held) { ... }
console.log(KeyMan.key("a").heldTime)

 */



class CKeyInfo {
    constructor(props = {}) {
        this.held = false
        this.triggered = false;
        this.downStartTime = this.timer()
        this.pressDuration = 0;
        this.allowRepeats = props.allowRepeats ?? false;
        this.callbackDown = null;
        this.callbackUp = null;
        this.repeatCount = 0;
    }

    onDown(callback) {
        this.callbackDown = callback
        return this;
    }

    onUp(callback) {
        this.callbackUp = callback
        return this;
    }

    timer() {
        return Date.now()
    }

    down(e) {
        if (!this.held) {
            this.held = true;
            this.triggered = true;
            this.downStartTime = this.timer()
            this.repeatCount = 0;
            if (this.callbackDown) {
                this.callbackDown(e, this);
            }
        } else if (this.allowRepeats) {
            this.repeatCount++;
            if (this.callbackDown) {
                this.callbackDown(e, this);
            }
        }
    }

    up(e) {
        if (this.held) {
            this.held = false;
            this.pressDuration = this.timer() - this.downStartTime
            if (this.callbackUp) {
                this.callbackUp(e, this);
            }
        }
    }

    get heldTime() {
        if (this.held) {
            return this.timer() - this.downStartTime
        }
        return 0;
    }
}


class CKeyBoardManager {
    constructor(props = {}) {
        this.keys = {}
        this.keyCodes = {}
    }

    key(key) {
        if (this.keys[key] === undefined) {
            this.keys[key] = new CKeyInfo()
        }
        return this.keys[key]
    }

    keyCode(keyCode) {
        if (this.keyCodes[keyCode] === undefined) {
            this.keyCodes[keyCode] = new CKeyInfo()
        }
        return this.keyCodes[keyCode]
    }

    isKeyHeld(key) {
        return this.keys[key]?.held ?? false;
    }

    isKeyCodeHeld(keyCode) {
        return this.keyCodes[keyCode]?.held ?? false;
    }

    handleKeyDown(e) {
        const key = e.key.toLowerCase();
        const keyCode = e.code;

        this.key(key).down(e);
        this.keyCode(keyCode).down(e);
    }

    handleKeyUp(e) {
        const key = e.key.toLowerCase();
        const keyCode = e.code;

        this.key(key).up(e);
        this.keyCode(keyCode).up(e);
    }

    clearAll() {
        for (const key in this.keys) {
            if (this.keys[key].held) {
                this.keys[key].up();
            }
        }
        for (const keyCode in this.keyCodes) {
            if (this.keyCodes[keyCode].held) {
                this.keyCodes[keyCode].up();
            }
        }
    }
}

const KeyMan = new CKeyBoardManager()

export { KeyMan }

export function isKeyHeld(key) {
    return KeyMan.isKeyHeld(key.toLowerCase());
}

export function keyHeldTime(key) {
    return KeyMan.key(key.toLowerCase()).heldTime;
}

export function isKeyCodeHeld(code) {
    return KeyMan.isKeyCodeHeld(code);
}

export function wut() {
    return 1;
}

// a quickToggle is a more immediate mode UI toggle you can just use
export const toggles = {}
export const toggler = function (key, controller) {
    toggles[key] = controller;
}
// generic toggler that has a callback and some data that's passed to that callback
// along with the
export const genericToggles = {}
// a generic toggler just sets up a key/gui pair
// and calls the callback when there's a change
function togglerGeneric(key, data, gui, name, callback) {
    genericToggles[key] = {
        data: data,
        gui: gui,
        callback: callback,
        value: false,
        name: name,
    }
    const controller = gui.add(genericToggles[key], "value").name(name).listen().onChange(
        (newValue) => {
            genericToggles[key].callback(genericToggles[key], newValue)
        })
    genericToggles[key].guiController = controller;
}

export function togglerNodes(key, nodes, gui, name, callback) {
    togglerGeneric(key, nodes, gui, name, (toggle, value) => {
//        console.log(nodes)
        nodes.forEach(nodeName => {
//            ViewMan.get(n).setVisible(value);
            if (NodeMan.exists(nodeName)) {
                console.log("Toggling " + nodeName)

                const node = NodeMan.get(nodeName)
                console.log("Node:  " + node)

                node.setVisible(value);
            } else {
                console.warn("togglerNodes called with non-existant node "+nodeName)
            }
        })
        callback()
    })
}

// and it will be created if needed
export const quickToggles = {}

export function quickToggle(key, start = false, toggleGui = gui) {
    if (quickToggles[key] === undefined) {
        quickToggles[key] = {gui: null, value: start};
        quickToggles[key].gui = toggleGui.add(quickToggles[key], "value").name(key).onChange(()=>{
            setRenderOne(true);
        })
    }
    return quickToggles[key].value
}

export function showHider(_ob, id, visible, key) {
    const ob = _ob;
    if (visible === undefined) visible = false;
    if (par[id] !== undefined && toggles[key] === undefined) {
        // the flag already exists, but no gui controller set up yet
        // so we use what is set up in there (e.g. it was serialized)
        visible = par[id]
    } else {
        par[id] = visible
    }
    ob.visible = visible
    ob.showHiderID = id;
    const con = toggles[key] ?? guiShowHide.add(par, id).listen();

    con.onChange(value => {
        if (value)
            ob.visible = true
        else
            ob.visible = false

        // if it's got a Three.js group then also set that.
        if (ob.group !== undefined) {
            ob.group.visible = ob.visible;
        }

    })

    if (key !== undefined) {
        toggles[key] = con
    }
    return con;
}

let isFullScreen = false;

function isTextInputFocused() {
    const activeElement = document.activeElement;
    if (!activeElement) return false;
    
    const tagName = activeElement.tagName.toLowerCase();
    if (tagName === 'input') {
        const inputType = (activeElement.type || 'text').toLowerCase();
        return ['text', 'number', 'email', 'password', 'search', 'tel', 'url'].includes(inputType);
    }
    return tagName === 'textarea';
}

export function initKeyboard() {
    document.onkeydown = function (e) {

        // If focus is on a text input, don't process keyboard shortcuts
        // This allows normal text operations to work in input fields
        if (isTextInputFocused()) {
            return;
        }

        if (e.repeat && e.code !== 'Comma' && e.code !== 'Period') return;

        setRenderOne(true);

        const keyCode = e.code
        const key = e.key.toLowerCase()

        if ((e.ctrlKey || e.metaKey) && keyCode === 'KeyS') {
            e.preventDefault();
            if (FileManager && FileManager.saveSitchFromMenu) {
                FileManager.saveSitchFromMenu();
            }
            return;
        }

        KeyMan.handleKeyDown(e);

        EventManager.dispatchEvent("keydown", {key: key, keyCode: keyCode, event: e});


        if (NodeMan.exists("mainCamera")) {

            const cameraNode = NodeMan.get("mainCamera")
            const c = cameraNode.camera;

            switch (keyCode) {
                case 'NumpadDecimal':
                    c.up.set(0, 1, 0);
                    cameraNode.resetCamera();
                    break

                // these numpad keys (intened to reset camera postiona) are largely useless right now
                // especially on Globes

                // case 'NumPad0':
                //     c.up.set(0, 1, 0);
                //     break;

                case 'Numpad1':
                    c.position.x = 0;
                    c.position.y = 0;
                    c.position.z = Sit.defaultCameraDist;  // 1300 works for 10°
                    c.up.set(0, 1, 0);

                    c.lookAt(new Vector3(0, 0, 0));
                    break;

                case 'Numpad7':
                    c.position.x = 0;
                    c.position.y = Sit.defaultCameraDist;
                    c.position.z = 0;
                    c.up.set(0, 1, 0);
                    //      c.up.x = 0;
                    //      c.up.y = 0;
                    //      c.up.z = -1;

                    c.lookAt(new Vector3(0, 0, 0));
                    break;

                case 'Numpad3':
                    c.position.x = Sit.defaultCameraDist;
                    c.position.y = 0;
                    c.position.z = 0;
                    c.up.set(0, 1, 0);

                    c.lookAt(new Vector3(0, 0, 0));
                    break;

                case 'Numpad9':
                    c.position.x = -c.position.x;
                    c.position.y = -c.position.y;
                    c.position.z = -c.position.z;

                    c.lookAt(new Vector3(0, 0, 0));
                    break;
            }
        }

        // Handle undo/redo with Ctrl/Cmd modifiers
        if (UndoManager) {
            // Undo: Ctrl+Z or Cmd+Z
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && keyCode === 'KeyZ') {
                e.preventDefault();
                UndoManager.undo();
                return;
            }
            
            // Redo: Ctrl+Y or Cmd+Y or Ctrl+Shift+Z or Cmd+Shift+Z
            if ((e.ctrlKey || e.metaKey) && (keyCode === 'KeyY' || (e.shiftKey && keyCode === 'KeyZ'))) {
                e.preventDefault();
                UndoManager.redo();
                return;
            }
        }

        // and things that don't rely on the camera
        switch (keyCode) {


            case 'Space' :
                e.preventDefault();
                par.paused = !par.paused;
                break;

            case 'KeyU' :
                Globals.menuBar.toggleVisiblity();
                break;
            case 'KeyF':
                if (!isFullScreen) {
                    isFullScreen = !isFullScreen
                    openFullscreen()
                } else {
                    isFullScreen = !isFullScreen
                    closeFullscreen()
                }
                break;

            // single step
            case 'Comma':
                par.frame = Math.floor(par.frame-1);
                if (par.frame < 0) par.frame = 0;
                par.paused = true;
                setRenderOne(2);
                break;

            case 'Period':
                par.frame = Math.floor(par.frame+1);
                if (par.frame > Sit.frames - 1) par.frame = Sit.frames - 1;
                par.paused = true;
                setRenderOne(2);
                break;

            // Delete key triggers delete for currently editing object
            case 'Delete':
            case 'Backspace':
                if (Globals.editingBuilding) {
                    e.preventDefault();
                    Globals.editingBuilding.deleteBuilding();
                } else if (Globals.editingClouds) {
                    e.preventDefault();
                    Globals.editingClouds.deleteClouds();
                } else if (Globals.editingOverlay) {
                    e.preventDefault();
                    Globals.editingOverlay.deleteOverlay();
                }
                break;

        }

        // now see if keycode is in the gui togglers array
        let guiController = toggles[key]
        if (guiController !== undefined) {
            guiController.setValue(!guiController.getValue())
        }

        guiController = quickToggles[key]
        if (guiController !== undefined) {
            guiController.setValue(!guiController.getValue())
        }

        const toggleData = genericToggles[key]
        if (toggleData !== undefined) {
            toggleData.guiController.setValue(!toggleData.guiController.getValue())
        }


    }

    document.onkeyup = function (e) {
        KeyMan.handleKeyUp(e);
    }

    window.onfocus = () => {
        KeyMan.clearAll();
    }


}