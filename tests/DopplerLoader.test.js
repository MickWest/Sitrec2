jest.mock("../src/configUtils",()=>({isAdmin:jest.fn(()=>true)}));
jest.mock("../src/doppler/DopplerTool",()=>({DopplerTool:jest.fn().mockImplementation(()=>({show:jest.fn(),dispose:jest.fn()}))}));
import {isAdmin} from "../src/configUtils";
import {DopplerTool} from "../src/doppler/DopplerTool";
import {addDopplerGeolocationMenu,disposeDopplerGeolocation,openDopplerGeolocation} from "../src/doppler/DopplerLoader";

afterEach(()=>{disposeDopplerGeolocation();jest.clearAllMocks();isAdmin.mockReturnValue(true);});
test("non-admin users get neither the menu nor an addon instance",async()=>{
    isAdmin.mockReturnValue(false);
    const folder={add:jest.fn()};addDopplerGeolocationMenu(folder);
    expect(folder.add).not.toHaveBeenCalled();
    expect(await openDopplerGeolocation()).toBeNull();expect(DopplerTool).not.toHaveBeenCalled();
});
test("concurrent opens share one lazy instance and disposal cancels a pending open",async()=>{
    await Promise.all([openDopplerGeolocation(),openDopplerGeolocation()]);
    expect(DopplerTool).toHaveBeenCalledTimes(1);
    disposeDopplerGeolocation();jest.clearAllMocks();
    const pending=openDopplerGeolocation();disposeDopplerGeolocation();
    expect(await pending).toBeNull();expect(DopplerTool).not.toHaveBeenCalled();
});
