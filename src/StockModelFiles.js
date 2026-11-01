// StockModelFiles.js
//
// Recognizes Sitrec's own model files when they arrive as a file reference, not as a menu name.

/**
 * Finds the ModelFiles key of a stock model from a file reference. A saved sitch holds a stock
 * model as the relative id "data/models/A-10.glb", or "models/A-10.glb", with spaces as %20 or
 * with a name in modelAliases. A full URL is never stock: it can point at anyone's file.
 *
 * @param {string} fileRef - The file reference
 * @param {Object} modelFiles - The ModelFiles table: menu name -> {file}
 * @param {Object} modelAliases - Old file path -> current file path
 * @returns {string|null} The menu name, or null if this is not a stock model file
 */
export function findStockModelKey(fileRef, modelFiles, modelAliases) {
    const match = /^(?:data\/)?models\/([^?#]+)/.exec(String(fileRef));
    if (!match) return null;

    const file = `data/models/${match[1].replaceAll("%20", " ")}`;
    const currentFile = modelAliases[file] ?? file;
    const stockModel = Object.entries(modelFiles).find(([, model]) => model.file === currentFile);
    return stockModel ? stockModel[0] : null;
}
