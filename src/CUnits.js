// a uitlity class for converting units
// focussing on the standard units used by situations
// Systems are
// 1. Metric
// 2. Imperial / Statute
// 3. Nautical

import {guiPhysics, NodeMan} from "./Globals";
import {assert} from "./assert";

// The unit systems a user can pick, as {menu label: internal key}. Shared with the
// "Units" startup preference in the Settings menu, so the two lists cannot drift.
// Treat as read-only — every CUnits instance shares this one object.
export const SELECTABLE_UNITS = {
    "Nautical": "nautical",
    "Imperial/US": "imperial",
    "Metric": "metric",
    "Feet only": "feet",
};

export class CUnits {
    constructor(_units = "metric", gui) {

        this.factors = {
            nautical: {
                big: {
                    name: "Nautical Miles",
                    abbrev: "NM",
                    toM: 1852
                },
                small: {
                    name: "Feet",
                    abbrev: "ft",
                    toM: 0.3048
                },
                speed: {
                    name: "Knots",
                    abbrev: "kt",
                    toM: 1852 / 3600
                },
                verticalSpeed: {
                    name: "Feet per minute",
                    abbrev: "fpm",
                    toM: 0.00508
                }
            },
            imperial: {
                big: {
                    name: "Miles",
                    abbrev: "mi",
                    toM: 1609.344
                },
                small: {
                    name: "Feet",
                    abbrev: "ft",
                    toM: 0.3048
                },
                speed: {
                    name: "Miles per hour",
                    abbrev: "mph",
                    toM: 1609.344 / 3600
                },
                verticalSpeed: {
                    name: "Feet per minute",
                    abbrev: "fpm",
                    toM: 0.00508
                }
            },
            metric: {
                big: {
                    name: "Kilometers",
                    abbrev: "km",
                    toM: 1000
                },
                small: {
                    name: "Meters",
                    abbrev: "m",
                    toM: 1
                },
                speed: {
                    name: "Kilometers per hour",
                    abbrev: "km/h",
                    toM: 1000 / 3600
                },
                verticalSpeed: {
                    name: "Meters per second",
                    abbrev: "m/s",
                    toM: 1
                }
            },
            feet: {
                big: {
                    name: "Feet",
                    abbrev: "ft",
                    toM: 0.3048

                },
                small: {
                    name: "Feet",
                    abbrev: "ft",
                    toM: 0.3048
                },
                speed: {
                    name: "Feet per hour",
                    abbrev: "fph",
                    toM: 0.3048 / 3600
                },
                verticalSpeed: {
                    name: "Feet per minute",
                    abbrev: "fpm",
                    toM: 0.3048 / 60
                }
            }
        }

        this.units = _units.toLowerCase();
        this.selectableUnits = SELECTABLE_UNITS;
        this.changeUnits(this.units);
        if(guiPhysics)
            guiPhysics.add(this, "unitsName", this.selectableUnits).name("Units")
                .tooltip("Unit system for speed, distance, and altitude displays")
                .listen()
                .perm()
                .onChange(x => this.changeUnits(x,false));




    }

    modSerialize() {
        return {units: this.units};
    }

    modDeserialize(v) {

        // we need to set the lastUnits to undefined so that the changeUnits method
        // will not try to convert the GUIValue nodes
        this.lastUnits = undefined;

        this.changeUnits(v.units, true);
    }




    // toM conversion factors go to meters and meters per second

    changeUnits(_units, updateGUI=true) {
//        console.log("CUnits: changeUnits: " + _units);
        this.units = _units.toLowerCase();

        if (this.units !== this.lastUnits ) {
//            console.log("CUnits: changeUnits: to " + this.units + "from lastUnits: " + this.lastUnits);

            // set current
            this.big = this.factors[this.units].big;
            this.small = this.factors[this.units].small;
            this.speed = this.factors[this.units].speed;
            this.verticalSpeed = this.factors[this.units].verticalSpeed;


            // backwards compatibility, could replace these where
            // but for now just set them to avoid major code changed
            this.bigUnitsFull = this.big.name;
            this.bigUnitsAbbrev = this.big.abbrev;
            this.smallUnitsFull = this.small.name;
            this.smallUnitsAbbrev = this.small.abbrev;
            this.vsUnits = this.verticalSpeed.name;
            this.speedUnits = this.speed.name;
            this.big2M = this.big.toM;
            this.small2M = this.small.toM;
            this.vs2mps = this.verticalSpeed.toM;

            this.m2Big = 1 / this.big2M;
            this.m2Small = 1 / this.small2M;
            this.m2Speed = 3600 * this.m2Big; // m/s to big units. so 3600 m in one hour, convert 3600 m to big units
            this.speed2M = 1 / this.m2Speed;

            if (this.lastUnits !== undefined) {
                // now calculate a scaling factor from the old units to the new
                // for each of the big, small, speed, and vertical speed
                // this is used to convert old values to new values
                const scaleFactors = this.getScaleFactors(this.lastUnits);
                console.log("CUnits: scaleFactors: ", scaleFactors);

                // we now inform any nodes that have a changeUnits method
                // to update their values
                NodeMan.iterate((id, node) => {
                    if (node.changeUnits !== undefined) {
                        node.changeUnits(this.units, scaleFactors);
                    }
                });
            } else {
                // No previous units (initialization or deserialization):
                // values are already correct, but GUI labels need updating
                NodeMan.iterate((id, node) => {
                    if (node.updateDesc !== undefined) {
                        node.updateDesc();
                    }
                });
            }

            if (updateGUI) {
                // find the unitName from the units, setting it for the GUI
                for (let [unitName, unit] of Object.entries(this.selectableUnits)) {
//                console.log("unitName: " + unitName + " unit: " + unit + " this.units: " + this.units)
                    if (unit.toLowerCase() === this.units) {
                        this.unitsName = unitName;
//                    console.log("Found unitName: " + unitName + " unit: " + unit + " this.units: " + this.units)
                        break;
                    }
                }
            }
            this.lastUnits = this.units;
        }
    }

    // given the previous units, get the scale factors to convert to the current units.
    getScaleFactors(previousUnits) {
        return {
            big:   this.factors[previousUnits].big.toM / this.big2M ,
            small: this.factors[previousUnits].small.toM / this.small2M,
            speed: this.factors[previousUnits].speed.toM / this.speed2M,
            verticalSpeed: this.factors[previousUnits].verticalSpeed.toM / this.vs2mps
        }
    }


    // convert meters to the big units
    mToBig(m, decimals = 0) {
        return (m * this.m2Big).toFixed(decimals);
    }

    bigWithUnits(m, decimals = 0) {
        return this.mToBig(m,decimals) + " " + this.bigUnitsAbbrev;
    }

    // convert meters to the small units
    mToSmall(m, decimals = 0) {
        return (m * this.m2Small).toFixed(decimals);
    }

    smallWithUnits(m, decimals = 0) {
        return this.mToSmall(m,decimals) + " " + this.smallUnitsAbbrev;
    }

    flexibleWithUnits(m, decimals = 0) {
        let large = this.mToBig(m, decimals);
        if (large < 1) {
            return this.smallWithUnits(m, decimals);
        } else {
            return this.bigWithUnits(m, decimals);
        }
    }

    withUnits(m, decimals=0, unitType="big") {
        if (unitType === "big")
            return this.bigWithUnits(m, decimals);
        else if (unitType === "small")
            return this.smallWithUnits(m, decimals);
        else if (unitType === "flexible")
            return this.flexibleWithUnits(m, decimals);
        else
            assert(0, "CUnits: unknown unitType: " + unitType);
    }


    // convert meters/second to speed units
    speed(m) {
        return m * this.m2Speed;
    }

    convertMeters(m, unitType="big", decimals=0) {
        switch (unitType) {
            case "big":
                return this.big(m);
            case "small":
                return this.small(m);
            default:
                assert(0, "CUnits: unknown units: " + unitType);
        }
    }


}