# ICAO aircraft types

`icao_aircraft_types.json` maps each ICAO aircraft type designator to its
description code and wake turbulence category, for example
`"B738": {"desc": "L2J", "wtc": "M"}`. The last letter of the description code
is the engine type: `J` jet, `T` turboprop or turboshaft, `P` piston,
`E` electric, `R` rocket; a few entries have `-` (no engine type). Doppler
geolocation uses it to leave jets (`J`) out of the event match when
"Exclude jets" is on.

Source: the Mictronics aircraft database,
https://github.com/Mictronics/aircraft-database (`icao_aircraft_types.zip`,
generated 2026-11-01). The file is unchanged.

Contains information from the Mictronics aircraft database
(https://github.com/Mictronics/aircraft-database), which is made available
under the ODC Attribution License
(https://opendatacommons.org/licenses/by/1-0/). The full license text is in
`LICENSE` in this folder.

To update it, download `icao_aircraft_types.zip` from that repository and
replace both files with the ones in the archive.
