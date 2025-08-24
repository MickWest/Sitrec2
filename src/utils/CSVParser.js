/**
 * Modern CSV Parser
 * 
 * A lightweight, modern CSV parser that replaces the jQuery.csv functionality.
 * This implementation focuses on the core functionality needed by the application
 * while maintaining compatibility with the existing API.
 */

/**
 * Default configuration options
 */
const defaults = {
  separator: ',',
  delimiter: '"',
  headers: true,
  newline: '\r\n'
};

/**
 * Parse a CSV string into an array of arrays
 * @param {string} csvString - The CSV string to parse
 * @param {Object} options - Optional configuration options
 * @returns {Array} - Array of arrays representing the CSV data
 */
function toArrays(csvString, options = {}) {
  if (typeof csvString !== 'string') {
    throw new Error('CSV data must be a string');
  }

  const config = {
    separator: options.separator || defaults.separator,
    delimiter: options.delimiter || defaults.delimiter,
    newline: options.newline || defaults.newline
  };

  // Handle empty input
  if (csvString.trim() === '') {
    return [];
  }

  // Split the CSV string into lines
  let lines = csvString.split(/\r\n|\n|\r/);
  
  // Remove empty lines at the end
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  // Parse each line
  return lines.map(line => parseLine(line, config));
}

/**
 * Parse a single CSV line into an array of values
 * @param {string} line - A single line from a CSV file
 * @param {Object} config - Configuration options
 * @returns {Array} - Array of values from the line
 */
function parseLine(line, config) {
  const { separator, delimiter } = config;
  const result = [];
  let currentValue = '';
  let insideQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1] || '';
    
    // Handle delimiters (quotes)
    if (char === delimiter) {
      if (insideQuotes && nextChar === delimiter) {
        // Escaped delimiter (double quotes)
        currentValue += delimiter;
        i++; // Skip the next quote
      } else {
        // Toggle insideQuotes flag
        insideQuotes = !insideQuotes;
      }
      continue;
    }
    
    // Handle separators (commas)
    if (char === separator && !insideQuotes) {
      result.push(currentValue);
      currentValue = '';
      continue;
    }
    
    // Add character to current value
    currentValue += char;
  }
  
  // Add the last value
  result.push(currentValue);
  
  return result;
}

/**
 * Parse a CSV string into an array of objects using the first row as headers
 * @param {string} csvString - The CSV string to parse
 * @param {Object} options - Optional configuration options
 * @returns {Array} - Array of objects representing the CSV data
 */
function toObjects(csvString, options = {}) {
  const arrays = toArrays(csvString, options);
  
  if (arrays.length < 2) {
    return [];
  }
  
  const headers = arrays[0];
  const result = [];
  
  for (let i = 1; i < arrays.length; i++) {
    const row = arrays[i];
    const obj = {};
    
    for (let j = 0; j < headers.length; j++) {
      if (j < row.length) {
        obj[headers[j]] = row[j];
      }
    }
    
    result.push(obj);
  }
  
  return result;
}

/**
 * Convert an array of arrays to a CSV string
 * @param {Array} data - Array of arrays to convert
 * @param {Object} options - Optional configuration options
 * @returns {string} - CSV string
 */
function fromArrays(data, options = {}) {
  if (!Array.isArray(data)) {
    throw new Error('Input data must be an array');
  }
  
  const config = {
    separator: options.separator || defaults.separator,
    delimiter: options.delimiter || defaults.delimiter,
    newline: options.newline || defaults.newline
  };
  
  return data.map(row => {
    if (!Array.isArray(row)) {
      throw new Error('Each row must be an array');
    }
    
    return row.map(value => {
      // Convert value to string
      const stringValue = String(value !== null && value !== undefined ? value : '');
      
      // Check if value needs to be quoted
      if (
        stringValue.includes(config.separator) ||
        stringValue.includes(config.delimiter) ||
        stringValue.includes('\n') ||
        stringValue.includes('\r')
      ) {
        // Escape quotes by doubling them and wrap in quotes
        return config.delimiter + 
               stringValue.replace(new RegExp(config.delimiter, 'g'), config.delimiter + config.delimiter) + 
               config.delimiter;
      }
      
      return stringValue;
    }).join(config.separator);
  }).join(config.newline);
}

/**
 * Convert an array of objects to a CSV string
 * @param {Array} data - Array of objects to convert
 * @param {Object} options - Optional configuration options
 * @returns {string} - CSV string
 */
function fromObjects(data, options = {}) {
  if (!Array.isArray(data) || data.length === 0) {
    return '';
  }
  
  // Get all unique keys from all objects
  const headers = [];
  data.forEach(obj => {
    Object.keys(obj).forEach(key => {
      if (!headers.includes(key)) {
        headers.push(key);
      }
    });
  });
  
  // Convert objects to arrays
  const arrays = [headers];
  
  data.forEach(obj => {
    const row = headers.map(header => obj[header] !== undefined ? obj[header] : '');
    arrays.push(row);
  });
  
  return fromArrays(arrays, options);
}

// Export the CSV parser functions
export default {
  defaults,
  toArrays,
  toObjects,
  fromArrays,
  fromObjects
};