// utils/geometry.js - COMPLETELY REWRITTEN FOR ROBUSTNESS
import { featureCollection, buffer, coordAll, length as _length, along, lineString, booleanDisjoint } from '@turf/turf';

/**
 * 🔧 HELPER: Ensure geometry is a valid Turf-compatible object
 */
function cleanGeometry(geom) {
  if (!geom || !geom.type || !geom.coordinates) return null;
  
  // Handle Multi* geometries by taking the largest part
  if (geom.type === 'MultiLineString' || geom.type === 'MultiPolygon') {
    const parts = geom.coordinates;
    const largest = parts.reduce((a, b) => 
      (Array.isArray(a) ? a.flat(Infinity).length : 0) > 
      (Array.isArray(b) ? b.flat(Infinity).length : 0) ? a : b
    );
    return {
      type: geom.type.replace('Multi', ''),
      coordinates: largest
    };
  }
  
  // Ensure coordinates are numbers (not strings)
  if (Array.isArray(geom.coordinates)) {
    const cleanCoords = geom.coordinates.map(coord => {
      if (Array.isArray(coord)) {
        return coord.map(c => typeof c === 'string' ? parseFloat(c) : c);
      }
      return typeof coord === 'string' ? parseFloat(coord) : coord;
    });
    return { ...geom, coordinates: cleanCoords };
  }
  
  return geom;
}

/**
 * 🛡️ createSchoolBuffers(schools, bufferMeters)
 * ✅ Now expects array of GeoJSON Features
 */
function createSchoolBuffers(schools, bufferMeters) {
  // Filter and clean valid school features
  const validSchools = schools
    .filter(s => s?.geometry?.coordinates)
    .map(s => ({
      type: 'Feature',
      geometry: cleanGeometry(s.geometry),
      properties: s.properties || {}
    }))
    .filter(s => s.geometry !== null);
  
  if (validSchools.length === 0) {
    console.warn(`⚠️ No valid schools found for buffering (checked ${schools.length} records)`);
    return featureCollection([]);
  }
  
  try {
    const fc = featureCollection(validSchools);
    return buffer(fc, bufferMeters, { units: 'meters' });
  } catch (err) {
    console.error('❌ Error buffering schools:', err.message);
    return featureCollection([]);
  }
}

/**
 * 📍 extractCorners(features, type, startId)
 * ✅ Handles Features with geometry property
 */
function extractCorners(features, type, startId = 0) {
  const nodes = [];
  let id = startId;

  features.forEach(feature => {
    try {
      // Get geometry from Feature or use directly if already a geometry
      const geom = cleanGeometry(feature.geometry || feature);
      if (!geom) return;
      
      const coords = coordAll({ type: 'Feature', geometry: geom });
      
      coords.forEach(coord => {
        // Ensure numbers + validate degree range
        const cleanCoord = coord.map(c => {
          const num = typeof c === 'string' ? parseFloat(c) : c;
          return typeof num === 'number' ? num : 0;
        });
        
        // Only accept coordinates in degrees (WGS84 range)
        if (Math.abs(cleanCoord[0]) <= 180 && Math.abs(cleanCoord[1]) <= 90) {
          nodes.push({ id: id++, type, coord: cleanCoord });
        }
      });
    } catch (err) {
      // Skip problematic features silently
    }
  });

  return nodes;
}

/**
 * 🛣️ sampleRoadPoints(roadFeatures, intervalMeters, startId)
 * ✅ Robust sampling with degree validation
 */
// utils/geometry.js - UPDATE sampleRoadPoints for adaptive density

function sampleRoadPoints(roadFeatures, baseIntervalMeters, startId = 0) {
  const nodes = [];
  let id = startId;

  roadFeatures.forEach((roadFeat, idx) => {
    try {
      const geom = cleanGeometry(roadFeat.geometry || roadFeat);
      if (!geom || geom.type !== 'LineString') return;
      
      // Validate degrees
      const firstCoord = geom.coordinates[0];
      if (!firstCoord || Math.abs(firstCoord[0]) > 180 || Math.abs(firstCoord[1]) > 90) return;
      
      const line = lineString(geom.coordinates);
      const roadLength = _length(line, { units: 'meters' });
      
      // 🔧 ADAPTIVE SAMPLING: Very sparse for long roads
      let interval = baseIntervalMeters;
      if (roadLength > 5000) interval = Math.max(interval, 300); // 300m for long roads
      if (roadLength > 10000) interval = Math.max(interval, 500); // 500m for very long
      
      // 🔧 HARD LIMIT: Max 50 points per road to prevent explosion
      const maxPoints = Math.min(50, Math.ceil(roadLength / interval));
      const actualInterval = roadLength / maxPoints;
      
      for (let dist = 0; dist <= roadLength && nodes.length - id < 50; dist += actualInterval) {
        const point = along(line, dist, { units: 'meters' });
        const cleanCoord = point.geometry.coordinates.map(c => 
          typeof c === 'string' ? parseFloat(c) : c
        );
        nodes.push({ id: id++, type: 'goal', coord: cleanCoord });
      }
      
    } catch (err) {
      // Skip silently
    }
  });

  console.log(`✅ Generated ${nodes.length} road sample points (sparse mode)`);
  return nodes;
}
export { createSchoolBuffers, extractCorners, sampleRoadPoints };