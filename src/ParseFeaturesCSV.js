import {findColumn, featureColumns, isFeaturesCSV} from "./ParseUtils";
import {FeatureManager} from "./CFeatureManager";
import {showError} from "./showError";
import {parseCoordinateCell} from "./CoordinateParser";

// The header sniff (isFeaturesCSV) lives in ParseUtils so light consumers —
// the shared CSV type detector in TrackCSV.js, headless tests — can use it
// without dragging FeatureManager's rendering chain in. Re-exported here so
// existing importers keep working.
export {isFeaturesCSV};

// a features CSV has lat, lon, alt, and label columns
// iterate over it and make markers with labels at those locations
export function extractFeaturesFromFile(csv) {
    console.log("Extracting FEATURES from CSV file");

    // Find column indices once before the loop
    const latCol = findColumn(csv, featureColumns.lat, true);
    const lonCol = findColumn(csv, featureColumns.lon, true);
    const altCol = findColumn(csv, featureColumns.alt, true);
    const labelCol = findColumn(csv, featureColumns.label, true);

    if (latCol === -1 || lonCol === -1 || labelCol === -1) {
        showError("FEATURES CSV missing required columns (lat, lon, label) alt is optional");
        return;
    }

    // Iterate over rows (skip header row at index 0)
    for (let i = 1; i < csv.length; i++) {
        const row = csv[i];

        const lat = parseCoordinateCell(row[latCol]);
        const lon = parseCoordinateCell(row[lonCol]);
        let alt = 0
        if (altCol !== -1) alt = parseFloat(row[altCol]);
        if (isNaN(alt)) alt = 0;
        // if no label, use a space to avoid issues with zero size textures
        let label = row[labelCol] ?? " ";
        if (label === "") label = " ";

        // Skip rows with invalid coordinates
        if (isNaN(lat) || isNaN(lon)) {
            continue;
        }

        // Create a feature marker using FeatureManager
        FeatureManager.addFeature({
            id: `feature_${i}_${label.replace(/\s+/g, '_')}`,
            text: label,
            positionLLA: {lat: lat, lon: lon, alt: alt},
        });
    }

    console.log(`Extracted ${FeatureManager.size()} feature markers`);
}