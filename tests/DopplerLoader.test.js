jest.mock("../src/configUtils",()=>({isAdmin:jest.fn(()=>true)}));
jest.mock("../src/doppler/DopplerTool",()=>({DopplerTool:jest.fn().mockImplementation(()=>({show:jest.fn(),dispose:jest.fn()}))}));
import {isAdmin} from "../src/configUtils";
import {DopplerTool} from "../src/doppler/DopplerTool";
import {par} from "../src/par";
import {Globals} from "../src/Globals";
import {addDopplerGeolocationMenu,disposeDopplerGeolocation,openDopplerGeolocation} from "../src/doppler/DopplerLoader";

// The tool is for an administrator, and for a user who is logged in.
const previousUser={userID:Globals.userID,testUserID:Globals.testUserID,userData:Globals.userData};
beforeEach(()=>{Globals.userID=0;Globals.testUserID=0;Globals.userData={userID:0,userGroups:[]};});
afterEach(()=>{disposeDopplerGeolocation();jest.clearAllMocks();isAdmin.mockReturnValue(true);Object.assign(Globals,previousUser);});
const menuFolder=()=>{const row={name:jest.fn(()=>row),tooltip:jest.fn(()=>row),perm:jest.fn(()=>row)};return {add:jest.fn(()=>row)};};
test("a visitor with no login, who is not an administrator, gets neither the menu nor an addon instance",async()=>{
    par.paused=false;
    isAdmin.mockReturnValue(false);
    const folder=menuFolder();addDopplerGeolocationMenu(folder);
    expect(folder.add).not.toHaveBeenCalled();
    expect(await openDopplerGeolocation()).toBeNull();expect(DopplerTool).not.toHaveBeenCalled();expect(par.paused).toBe(false);
});
test("a logged-in user who is not an administrator gets the menu and the tool",async()=>{
    par.paused=false;
    isAdmin.mockReturnValue(false);Globals.userID=42;Globals.userData={userID:42,userGroups:[2]};
    const folder=menuFolder();addDopplerGeolocationMenu(folder);
    expect(folder.add).toHaveBeenCalledTimes(1);
    expect(await openDopplerGeolocation()).not.toBeNull();expect(DopplerTool).toHaveBeenCalledTimes(1);expect(par.paused).toBe(true);
});
// A user ID alone is not a login. These two user data objects are the ones that
// asyncCheckLogin (login.js) sets when there is no login.
test.each([
    ["a build with no login",{userID:88888888,noLogin:true}],
    ["a failed login check on an installation that does not require a login",{userID:12345678,userGroups:[],noLogin:true}],
])("%s: its fixed user ID is not a login, so no menu and no tool",async(label,userData)=>{
    par.paused=false;
    isAdmin.mockReturnValue(false);Globals.userID=userData.userID;Globals.userData=userData;
    const folder=menuFolder();addDopplerGeolocationMenu(folder);
    expect(folder.add).not.toHaveBeenCalled();
    expect(await openDopplerGeolocation()).toBeNull();expect(DopplerTool).not.toHaveBeenCalled();expect(par.paused).toBe(false);
});
test("an administrator gets the menu",()=>{
    const folder=menuFolder();addDopplerGeolocationMenu(folder);
    expect(folder.add).toHaveBeenCalledTimes(1);
});
test("opening and reopening the tool pauses Sitrec playback",async()=>{
    par.paused=false;await openDopplerGeolocation();expect(par.paused).toBe(true);
    par.paused=false;await openDopplerGeolocation();expect(par.paused).toBe(true);
    expect(DopplerTool).toHaveBeenCalledTimes(1);
});
test("concurrent opens share one lazy instance and disposal cancels a pending open",async()=>{
    await Promise.all([openDopplerGeolocation(),openDopplerGeolocation()]);
    expect(DopplerTool).toHaveBeenCalledTimes(1);
    disposeDopplerGeolocation();jest.clearAllMocks();
    const pending=openDopplerGeolocation();disposeDopplerGeolocation();
    expect(await pending).toBeNull();expect(DopplerTool).not.toHaveBeenCalled();
});
