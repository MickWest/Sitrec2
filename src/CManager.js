import {CNodeConstant} from "./nodes/CNode";
import {assert} from "./assert";
import {CNodeController} from "./nodes/CNodeController";

// A CManager is a simple class that manages a list of objects
class CManager {
    constructor() {
        this.list = {}
        // Monotonic counter bumped on every add/remove. Consumers that derive an
        // expensive result from the CURRENT set of managed objects (e.g.
        // CNodeDisplayWindField._gatherSondeProfiles scanning for atmospheric
        // profiles) can memoize against this and skip a full re-scan while the
        // set is unchanged — critical for tight loops like the balloon bake,
        // which samples wind once per frame across 100k+ frames.
        this.listVersion = 0
    }

    size() {
        return Object.keys(this.list).length;
    }

    add (id, data, original=null) {
        assert (this.list[id] === undefined, "seem to be adding <"+id+"> twice to a CManager ")
        this.list[id] = {
            data: data,
            original: original,
        };
        this.listVersion++;
        return data; // for chaining
    }

    exists(id) {
        return this.list[id] !== undefined
    }

    // Given a desired name, return one that is free in this manager.
    //
    // Returns the name UNCHANGED when nothing holds it, which is what nearly every
    // caller gets and why ids stay readable. Only on a collision does it append
    // "_1", then "_2", and so on until one is free.
    //
    // The motivating case is the `${prefix}_${Date.now()}` id pattern used for
    // synthetic objects, tracks and balloons. Millisecond timestamps are not unique:
    // two objects created in the same millisecond produced the SAME id and the second
    // one threw out of CManager.add ("seem to be adding <id> twice to a CManager").
    // Measured live, two Add Object calls landed 19 ms apart, so this is narrow but
    // entirely reachable — a double click, a script, or a deserialize loop.
    //
    // Note this is a point-in-time answer: it is only safe to use the returned name
    // if you add() it before anything else can claim it, which is how all the id
    // generation here works (generate, then immediately construct).
    UniqueName(prefix) {
        if (!this.exists(prefix)) {
            return prefix;
        }
        let i = 1;
        while (this.exists(`${prefix}_${i}`)) {
            i++;
        }
        return `${prefix}_${i}`;
    }


    remove(id) {
        if (typeof id === "object") {
            id = id.id;
        }
        if (this.exists(id)) {
            delete this.list[id];
            this.listVersion++;
        }
    }

    disposeRemove(id) {
        if (id===undefined)
            return;
        let key;
        if (typeof id === "object") {
            key = id.id;
        } else {
            key = id;
        }
        if (this.exists(key)) {

            // the node should have no inputs or outputs
            // otherwise, it's not safe to remove it (we'll get a dangling reference)
            const node = this.list[key].data;


            //assert (node.id === key, "Trying to disposeRemove a node with a different id, key="+key+", node.id="+node.id);

            // node inputs is an object, it should be empty
            assert(node.inputs === undefined || Object.keys(node.inputs).length === 0, "Trying to disposeRemove a node with inputs, id="+key);
            // node outputs is an array, it should be empty
            assert(node.outputs === undefined || node.outputs.length === 0, "Trying to disposeRemove a node with outputs, id="+key);

            if (this.list[key].data.dispose !== undefined) {
//                console.log("Disposing " + key);
                this.list[key].data.dispose()
            }
            this.remove(key);
        }
    }

    pruneUnusedConstants() {
        for (let key in this.list) {
            if (this.list.hasOwnProperty(key)) {
                const node = this.list[key].data;
                // is it CNodeConstant class object?
                if (node instanceof CNodeConstant) {
                    // is it not connected to anything?
                    if (node.outputs.length === 0) {
                        // remove it
//                        console.log("Removing unused constant " + key);
                        this.unlinkDisposeRemove(key)
                    }

                }
            }
        }
    }

    pruneUnusedControllers() {
        for (let key in this.list) {
            if (this.list.hasOwnProperty(key)) {
                const node = this.list[key].data;
                if (node instanceof CNodeController) {
                    // is it not connected to anything?
                    if (node.outputs.length === 0) {
                        // remove it
                        console.log("Removing unused controller " + key);
                        this.unlinkDisposeRemove(key)
                    }

                }
            }
        }
    }

    // override in subclass (CNodeManager) to properly unlink inputs/outputs
    unlinkDisposeRemove(id) {
        this.disposeRemove(id);
    }


    // returns just the data member object (a parsed arraybuffer, type varies)
    get(id, assertIfMissing=true) {
        if (assertIfMissing) {
            if (this.list[id] === undefined) {
                console.log("Missing Managed object " + id + ", use exists() if you are just checking");
                console.log("Available keys are: ");
                // for (let key in this.list) {
                //     console.log("key", key)
                // }
            }
            assert(this.list[id] !== undefined, "Missing Managed object " + id + ", use exists() if you are just checking")
        }
        if (this.list[id] === undefined)
            return undefined;
        return this.list[id].data
    }

    getByIndex(index) {
        return this.list[Object.keys(this.list)[index]].data;
    }


    // returns the full object, so you can check filename, etc.
    getInfo(id) {


        assert(this.list[id] !== undefined, "Missing Managed object "+id+", use exists() if you are just checking")
        return this.list[id]
    }

    iterate (callback) {
        Object.keys(this.list).forEach(key => callback(key, this.list[key].data))
    }

    // bit crufty
    // test is called with the FileManager entry, but the callback uses the data
    iterateTest(test, callback) {
        Object.keys(this.list).forEach(key => {
            if (test(this.list[key])) {
                callback(key, this.list[key].data)
            }
        })
    }

    iterateVisible (callback) {
        Object.keys(this.list).forEach(key => {
            const view = this.list[key].data
            if (view._effectivelyVisible && !view.overlayView)
                callback(key, view);
        })
    }

    iterateVisibleIncludingOverlays (callback) {
        Object.keys(this.list).forEach(key => {
            const view = this.list[key].data
            if (view._effectivelyVisible)
                callback(key, view);
        })
    }

    deleteIf(test) {
        Object.keys(this.list).forEach(key => {
            if (test(this.list[key])) {
                console.log("removing " + this.list[key].filename);
                delete this.list[key];
            }
        });
    }

    findFirstData(test) {
        for (let key in this.list) {
            if (this.list.hasOwnProperty(key) && test(this.list[key])) {
                return this.list[key].data;
            }
        }
        return null;
    }

    disposeAll() {
        // delete all entries in this.list
        Object.keys(this.list).forEach(key => {
            this.disposeRemove(key);
        });

    }


}


export {CManager}