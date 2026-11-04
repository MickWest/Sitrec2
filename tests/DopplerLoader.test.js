jest.mock("../src/configUtils",()=>({isAdmin:jest.fn(()=>true)}));
jest.mock("../src/doppler/DopplerTool",()=>({DopplerTool:jest.fn().mockImplementation(()=>({show:jest.fn(),dispose:jest.fn()}))}));
import {isAdmin} from "../src/configUtils";
import {DopplerTool} from "../src/doppler/DopplerTool";
import {par} from "../src/par";
import {addDopplerGeolocationMenu,disposeDopplerGeolocation,openDopplerGeolocation} from "../src/doppler/DopplerLoader";

afterEach(()=>{disposeDopplerGeolocation();jest.clearAllMocks();isAdmin.mockReturnValue(true);});
test("non-admin users get neither the menu nor an addon instance",async()=>{
    par.paused=false;
    isAdmin.mockReturnValue(false);
    const folder={add:jest.fn()};addDopplerGeolocationMenu(folder);
    expect(folder.add).not.toHaveBeenCalled();
    expect(await openDopplerGeolocation()).toBeNull();expect(DopplerTool).not.toHaveBeenCalled();expect(par.paused).toBe(false);
});
test("opening and reopening the admin tool pauses Sitrec playback",async()=>{
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
