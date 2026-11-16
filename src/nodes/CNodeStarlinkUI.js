import {CNode} from "./CNode";

// Accept explicit node definitions in older scenes. Standard menus now own all
// controls; CustomManagerSerialize migrates the old panel's visible state.
export class CNodeStarlinkUI extends CNode {}
