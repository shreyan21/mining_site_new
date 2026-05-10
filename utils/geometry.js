// utils/geometry.js
import {
  featureCollection,
  buffer,
  coordAll,
  length as turfLength,
  along,
  lineString,
  booleanDisjoint,
  centerOfMass,
  distance,
  nearestPointOnLine,
  bbox
} from '@turf/turf';

/**
 * 📌 WHAT THIS FILE DOES:
 * Contains pure geometry/math functions. No database calls here.
 * It transforms raw GeoJSON into the "nodes" and "safe zones" 
 * that the pathfinding algorithm needs.
 * 
 * 🔑 KEY POINT: All functions here work with GeoJSON objects, not database rows.
 */

/**
 * 🔧 HELPER: Clean and validate geometry
 * Ensures Turf.js receives valid input
 */
/**
 * 🔧 HELPER: Clean and validate geometry
 * Ensures Turf.js receives valid input
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
        // coord is [lon, lat] or similar → clean each value
        return coord.map(c => typeof c === 'string' ? parseFloat(c) : c);
      }
      // coord is a single value → clean it directly ✅ FIXED HERE
      return typeof coord === 'string' ? parseFloat(coord) : coord;
    });
    return { ...geom, coordinates: cleanCoords };
  }
  
  return geom;
}

/**
 * 🛡️ createSchoolBuffers(schools, bufferMeters)
 * 
 * 🎯 WHAT IT DOES:
 * Converts school POINTS into circular POLYGONS using the user's input.
 * 
 * 🧒 SIMPLE EXPLANATION:
 * Imagine each school is a dot on paper 🏫•
 * You take a compass, set it to 500m, and draw a circle around each dot 🛡️⭕
 * Now you have "no-build zones" around schools!
 * 
 * 📥 INPUT: 
 *   • schools: Array of GeoJSON Point features
 *   • bufferMeters: Number (e.g., 500) - how big the circles should be
 * 📤 OUTPUT: GeoJSON FeatureCollection of buffered polygons
 * 
 * 🔑 WHY THIS IS IMPORTANT:
 * This is where the USER'S input (500m) actually affects the path!
 * Change buffer to 300 → smaller circles → more possible paths
 * Change buffer to 1000 → bigger circles → fewer possible paths
 */
function createSchoolBuffers(schools, bufferMeters) {
  // Filter out invalid geometries first
  const validSchools = schools
    .filter(s => s?.geometry?.coordinates)
    .map(s => ({
      type: 'Feature',
      geometry: cleanGeometry(s.geometry),
      properties: s.properties || {}
    }))
    .filter(s => s.geometry !== null);
  
  if (validSchools.length === 0) {
    console.warn(`⚠️ No valid schools found for buffering`);
    return featureCollection([]);
  }
  
  try {
    const fc = featureCollection(validSchools);
    // buffer() expands each point outward by bufferMeters
    return buffer(fc, bufferMeters, { units: 'meters' });
  } catch (err) {
    console.error('❌ Error buffering schools:', err.message);
    return featureCollection([]);
  }
}

/**
 * 📍 extractCorners(features, type, startId, maxCornersPerFeature)
 * 
 * 🎯 WHAT IT DOES:
 * Pulls every vertex (corner) from polygons/lines.
 * 
 * 🧒 SIMPLE EXPLANATION:
 * Imagine a polygon is a shape drawn with a ruler 📐
 * extractCorners finds every point where the ruler changed direction
 * These corners become "bend points" so paths can legally wrap around obstacles
 * 
 * 📥 INPUT: 
 *   • features: Array of GeoJSON features (polygons or lines)
 *   • type: String label ('start', 'bend', 'goal') - what role these nodes play
 *   • startId: Number - starting ID for node numbering
 *   • maxCornersPerFeature: Number - max corners to extract per feature (default: 20)
 * 📤 OUTPUT: Array of node objects { id, type, coord: [lon, lat] }
 * 
 * 🔑 WHY CORNERS MATTER:
 * A straight line can't pass through an obstacle, but it CAN graze the corner
 * By making corners graph nodes, the algorithm can "turn" at exact obstacle edges
 */
function extractCorners(features, type, startId = 0, maxCornersPerFeature = 20) {
  const nodes = [];
  let id = startId;

  features.forEach((feature, idx) => {
    try {
      const geom = cleanGeometry(feature.geometry || feature);
      if (!geom) return;
      
      // Get all coordinates
      const allCoords = coordAll({ type: 'Feature', geometry: geom });
      
      // 🔧 LIMIT CORNERS: Take evenly-spaced samples if too many
      const coordsToUse = allCoords.length <= maxCornersPerFeature 
        ? allCoords 
        : allCoords.filter((_, i) => i % Math.ceil(allCoords.length / maxCornersPerFeature) === 0);
      
      coordsToUse.forEach(coord => {
        const cleanCoord = coord.map(c => {
          const num = typeof c === 'string' ? parseFloat(c) : c;
          return typeof num === 'number' ? num : 0;
        });
        
        // Validate degrees range (WGS84)
        if (Math.abs(cleanCoord[0]) <= 180 && Math.abs(cleanCoord[1]) <= 90) {
          nodes.push({ id: id++, type, coord: cleanCoord });
        }
      });
    } catch (err) {
      // Skip silently on error
    }
  });

  return nodes;
}

/**
 * 🛣️ sampleRoadPoints(roadFeatures, intervalMeters, startId, maxPointsPerRoad)
 * 
 * 🎯 WHAT IT DOES:
 * Places dots along road lines at regular intervals.
 * 
 * 🧒 SIMPLE EXPLANATION:
 * Imagine a road is a long string 🧵
 * You put a dot every 200 meters along the string •—•—•—•
 * These dots become "goal points" - the path can connect to ANY of them
 * 
 * 📥 INPUT: 
 *   • roadFeatures: Array of GeoJSON LineString/MultiLineString features
 *   • intervalMeters: Number (e.g., 200) - how far apart to place dots
 *   • startId: Number - starting ID for node numbering
 *   • maxPointsPerRoad: Number - max points to sample per road (default: 20)
 * 📤 OUTPUT: Array of goal node objects { id, type: 'goal', coord: [lon, lat] }
 * 
 * 🔑 WHY SAMPLING MATTERS:
 * Dijkstra works on discrete nodes, not infinite lines
 * Sampling every 200m gives enough precision without creating millions of nodes
 * 
 * 💡 FUTURE-PROOF TIP:
 * If you add more road tables later, just pass them to this function!
 * It doesn't care if roads come from "roads", "state_roads", or "village_paths"
 */
function sampleRoadPoints(roadFeatures, intervalMeters, startId = 0, maxPointsPerRoad = 20) {
  // ✅ Early exit if no roads
  if (!roadFeatures || roadFeatures.length === 0) {
    console.log(`⚠️ sampleRoadPoints: No roads to sample`);
    return [];
  }
  
  const nodes = [];
  let id = startId;

  roadFeatures.forEach((roadFeat, idx) => {
    try {
      const geom = cleanGeometry(roadFeat.geometry || roadFeat);
      if (!geom || geom.type !== 'LineString') return;
      
      // Validate coordinates are in DEGREES (not meters)
      const firstCoord = geom.coordinates[0];
      if (!firstCoord || Math.abs(firstCoord[0]) > 180 || Math.abs(firstCoord[1]) > 90) {
        console.warn(`⚠️ Road ${idx} has coordinates outside degree range - skipping`);
        return;
      }
      
      // Create Turf LineString from coordinates
      const line = lineString(geom.coordinates);
      
      // Calculate road length in METERS
      const roadLength = turfLength(line, { units: 'meters' });
      
      // 🔧 ADAPTIVE SAMPLING: Adjust interval based on road length
      let interval = intervalMeters;
      if (roadLength > 5000) interval = Math.max(interval, 300); // Longer roads → sparser sampling
      if (roadLength > 10000) interval = Math.max(interval, 500);
      
      // 🔧 HARD LIMIT: Use maxPointsPerRoad parameter (FIXED: was hardcoded 50)
      const maxPoints = Math.min(maxPointsPerRoad, Math.ceil(roadLength / interval));
      const actualInterval = roadLength / maxPoints;
      
      // Sample points along the line - FIXED: use maxPoints instead of hardcoded 50
      for (let dist = 0; dist <= roadLength && (id - startId) < maxPoints; dist += actualInterval) {
        const point = along(line, dist, { units: 'meters' });
        const cleanCoord = point.geometry.coordinates.map(c => 
          typeof c === 'string' ? parseFloat(c) : c
        );
        nodes.push({ id: id++, type: 'goal', coord: cleanCoord });
      }
      
    } catch (err) {
      console.warn(`⚠️ Error sampling road ${idx}:`, err.message);
    }
  });

  console.log(`✅ Generated ${nodes.length} road sample points`);
  return nodes;
}

export { createSchoolBuffers, extractCorners, sampleRoadPoints };