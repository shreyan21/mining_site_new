// server.js
import express from 'express';
import cors from 'cors';
import * as turf from '@turf/turf'; // Namespace import for all Turf functions

import { fetchSpatialData, pool } from './database/db.js';
import { createSchoolBuffers, extractCorners, sampleRoadPoints } from './utils/geometry.js';
import { buildVisibilityEdges, runDijkstra } from './pathfinder/graph.js';

const app = express();
app.use(cors()); // Allows frontend (OpenLayers) to call this API
app.use(express.json());

/**
 * 🌐 ROUTE: GET /api/connect
 * 
 * 🎯 WHAT THIS ROUTE DOES:
 * This is the MAIN API endpoint that ties everything together.
 * 
 * 🧒 SIMPLE EXPLANATION:
 * 1. User clicks a mine and types "500m"
 * 2. Server asks librarian (db.js) for data
 * 3. Server asks math teacher (geometry.js) to create school buffers
 * 4. Server asks navigator (graph.js) to find the shortest safe path
 * 5. Server sends the path back as GeoJSON for the map to draw
 * 
 * 📥 INPUT (via URL): 
 *   • mineGid: Number - which mine was clicked
 *   • buffer: Number - school safety distance in meters
 *   • force: "true" to enable relaxed constraints for difficult mines
 * 📤 OUTPUT: GeoJSON Feature with the path coordinates
 */
app.get('/api/connect', async (req, res) => {
  // 📥 1. Parse user input
  const { mineGid, buffer, force } = req.query;
  const forceMode = force === 'true';
  
  console.log(`🔧 Force mode: ${forceMode ? 'ENABLED (relaxed constraints)' : 'disabled (normal)'}`);
  
  // 🔧 ADAPTIVE PARAMETERS based on force mode
  const params = {
    // Search radius: larger if forced
    searchRadiusKm: forceMode ? 25 : 2,
    maxSearchRadiusKm: forceMode ? 50 : 15,
    radiusStep: forceMode ? 5 : 3,
    
    // Node limits: more nodes if forced (slower but thorough)
    cornerLimitPerObstacle: forceMode ? 25 : 8,
    roadSamplingInterval: forceMode ? 100 : 300,
    maxRoadPointsPerRoad: forceMode ? 50 : 20,
    
    // Edge building: allow longer edges if forced
    maxEdgeMeters: forceMode ? 20000 : 5000,
    
    // Obstacle filtering: less aggressive if forced
    obstacleFilterPadding: forceMode ? 0.05 : 0.02, // degrees (~5km vs ~2km)
    
    // Dijkstra: no early exit if forced
    allowLongPaths: forceMode
  };
  
  console.log(`📐 Using params: search=${params.searchRadiusKm}km, corners=${params.cornerLimitPerObstacle}, edges=${params.maxEdgeMeters}m`);
  
  if (!mineGid || !buffer) {
    return res.status(400).json({ error: 'Missing mineGid or buffer parameter' });
  }
  
  console.log(`🚀 Processing: Mine ${mineGid}, Buffer ${buffer}m`);
  
  try {
    // 📦 2. Fetch raw data from database (librarian)
    const data = await fetchSpatialData(parseInt(mineGid));
    
    // 🛡️ 3. Create school buffers (math teacher) - THIS IS WHERE USER INPUT MATTERS!
    const schoolBuffers = createSchoolBuffers(
      data.schools.map(s => s), // Pass school features
      parseInt(buffer)          // ← USER INPUT: 300, 500, 1000, etc.
    );
    
    // 🚧 4. Combine ALL obstacles into one list
    const allObstacles = [
      ...data.obstacles.mines,        // Other mine polygons
      ...data.obstacles.rivers,       // River polygons
      ...schoolBuffers.features       // ✅ Buffered school polygons!
    ].filter(o => o?.geometry); // Remove any nulls
    
    // 🎯 5. Calculate search area (bounding box) around the mine
    const mineBbox = turf.bbox(data.mine);
    
    // 🔧 ADAPTIVE SEARCH RADIUS: Start small, expand if needed
    let searchRadiusKm = params.searchRadiusKm;
    const maxSearchRadiusKm = params.maxSearchRadiusKm;
    const radiusStep = params.radiusStep;
    let nearbyRoads = [];
    const mineCenter = turf.centerOfMass(data.mine).geometry.coordinates;
    
    console.log(`🔍 Searching for roads near mine (center: [${mineCenter.map(c => c.toFixed(4)).join(', ')}])`);
    
    // 🔄 Progressive expansion: keep searching until we find roads or hit max radius
    while (searchRadiusKm <= maxSearchRadiusKm) {
      console.log(`🔄 Attempt ${searchRadiusKm}km radius...`);
      
      nearbyRoads = data.roads.filter(road => {
        try {
          // Get road's closest point to mine center for accurate distance
          const roadGeom = road.geometry || road;
          const nearest = turf.nearestPointOnLine(roadGeom, turf.point(mineCenter));
          const dist = turf.distance(mineCenter, nearest.geometry.coordinates, { units: 'kilometers' });
          return dist <= searchRadiusKm;
        } catch (err) {
          // Fallback: simple bbox check if nearestPoint fails
          try {
            const roadBbox = turf.bbox(road);
            const mineSearchBbox = [
              mineCenter[0] - searchRadiusKm / 111, mineCenter[1] - searchRadiusKm / 111,
              mineCenter[0] + searchRadiusKm / 111, mineCenter[1] + searchRadiusKm / 111
            ];
            return !(roadBbox[2] < mineSearchBbox[0] || roadBbox[0] > mineSearchBbox[2] ||
                     roadBbox[3] < mineSearchBbox[1] || roadBbox[1] > mineSearchBbox[3]);
          } catch { return false; }
        }
      });
      
      console.log(`🛣️ Found ${nearbyRoads.length} roads within ${searchRadiusKm}km`);
      
      // ✅ If we found roads, stop expanding
      if (nearbyRoads.length > 0) break;
      
      // ❌ No roads found, expand search radius
      searchRadiusKm += radiusStep;
    }
    
    // 🚨 Final check: if still no roads, return helpful error
    if (nearbyRoads.length === 0) {
      console.error(`❌ No roads found within ${maxSearchRadiusKm}km of mine #${mineGid}`);
      return res.status(404).json({ 
        error: 'No roads accessible', 
        hint: `Mine is isolated. Nearest road may be >${maxSearchRadiusKm}km away.`,
        mine_center: mineCenter,
        suggestion: 'Verify road data coverage or select a different mine',
        retry_url: forceMode ? null : `/api/connect?mineGid=${mineGid}&buffer=${buffer}&force=true`
      });
    }
    
    console.log(`✅ Using ${nearbyRoads.length} roads for pathfinding (found at ${searchRadiusKm}km radius)`);
    
    // 🧱 6. Filter obstacles to only those near the mine (performance)
    const padding = params.obstacleFilterPadding;
    const nearbyObstacles = allObstacles.filter(obs => {
      try {
        const obsBbox = turf.bbox(obs);
        return !(obsBbox[2] < mineBbox[0] - padding || obsBbox[0] > mineBbox[2] + padding ||
                 obsBbox[3] < mineBbox[1] - padding || obsBbox[1] > mineBbox[3] + padding);
      } catch { return false; }
    });
    console.log(`🧱 Using ${nearbyObstacles.length} of ${allObstacles.length} obstacles (spatial filter)`);
    
    // 📍 7. Generate Graph Nodes ("Dots")
    let nodeCounter = 0;
    
    // START: Corners of the selected mine
    const startNodes = extractCorners([data.mine], 'start', nodeCounter);
    nodeCounter += startNodes.length;
    
    // BEND: Corners of nearby obstacles (allows path to wrap around)
    const bendNodes = extractCorners(nearbyObstacles, 'bend', nodeCounter, params.cornerLimitPerObstacle);
    nodeCounter += bendNodes.length;
    
    // GOAL: Sampled points along nearby roads
    const goalNodes = sampleRoadPoints(nearbyRoads, params.roadSamplingInterval, nodeCounter, params.maxRoadPointsPerRoad);
    
    const nodes = [...startNodes, ...bendNodes, ...goalNodes];
    
    // 🔍 DEBUG: Node breakdown
    const startCount = nodes.filter(n => n.type === 'start').length;
    const goalCount = nodes.filter(n => n.type === 'goal').length;
    const bendCount = nodes.filter(n => n.type === 'bend').length;
    console.log(`📊 Node breakdown: start=${startCount}, bend=${bendCount}, goal=${goalCount}`);
    console.log(`⚙️ Built graph with ${nodes.length} nodes (target: <2000)`);
    
    // 🕸️ 8. Build Visibility Graph (Safe edges only)
    const edges = buildVisibilityEdges(nodes, allObstacles, null, params.maxEdgeMeters);
    
    // 🧭 9. Run Dijkstra to find shortest path
    console.log('🔍 Finding shortest safe path...');
    const pathCoords = runDijkstra(nodes, edges);
    
    // 🚨 EMERGENCY FALLBACK: If complex pathfinding fails, try straight line
    if (!pathCoords) {
      console.log('⚠️ Complex pathfinding failed. Trying emergency straight-line fallback...');
      
      try {
        let bestPoint = null;
        let bestDist = Infinity;
        
        // Check ALL roads (no filtering) for nearest point
        for (const road of data.roads) {
          try {
            const nearest = turf.nearestPointOnLine(road, turf.point(mineCenter));
            const dist = turf.distance(mineCenter, nearest.geometry.coordinates, { units: 'meters' });
            if (dist < bestDist) {
              bestDist = dist;
              bestPoint = nearest.geometry.coordinates;
            }
          } catch (e) {
            // Skip problematic roads
          }
        }
        
        if (bestPoint && bestDist < 1000) {
          console.log(`✅ FALLBACK SUCCESS: Straight line ${bestDist.toFixed(1)}m to road`);
          
          return res.json({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [mineCenter, bestPoint]
            },
            properties: {
              length_meters: bestDist.toFixed(1),
              method: 'emergency_fallback',
              warning: 'Obstacle avoidance disabled - verify path manually',
              buffer_applied: buffer,
              mine_gid: mineGid
            }
          });
        }
      } catch (err) {
        console.error('❌ Fallback failed:', err.message);
      }
      
      // 🎯 ANALYZE WHY IT FAILED and return helpful error
      const analysis = {
        mine_gid: mineGid,
        buffer_applied: buffer,
        force_mode: forceMode,
        search_radius_used: searchRadiusKm,
        nodes_generated: nodes.length,
        edges_created: edges.length,
        possible_reasons: []
      };
      
      if (nearbyRoads.length === 0) {
        analysis.possible_reasons.push('No roads found within search radius');
        analysis.suggestion = `Try increasing search radius or verify road data coverage`;
      } else if (goalCount === 0) {
        analysis.possible_reasons.push('No road sample points generated');
        analysis.suggestion = `Try reducing road sampling interval or check road geometry validity`;
      } else if (edges.length === 0) {
        analysis.possible_reasons.push('No safe edges could be created');
        analysis.suggestion = `Obstacles may completely block access. Try reducing buffer or enabling force mode`;
      } else {
        analysis.possible_reasons.push('Dijkstra could not find a path through available edges');
        analysis.suggestion = `Graph may be disconnected. Try enabling force mode for relaxed constraints`;
      }
      
      // If not in force mode, suggest enabling it
      if (!forceMode) {
        analysis.suggestion += ` OR retry with ?force=true to relax constraints`;
      }
      
      console.error(`❌ Path failed for mine ${mineGid}:`, analysis.possible_reasons.join('; '));
      
      return res.status(404).json({ 
        error: 'No safe path found', 
        hint: analysis.suggestion,
        debug: analysis,
        retry_url: !forceMode ? `/api/connect?mineGid=${mineGid}&buffer=${buffer}&force=true` : null
      });
    }
    
    // ✅ PATH FOUND: Build and return the response
    console.log('🔍 DEBUG: Preparing response...');
    console.log(`   pathCoords type: ${Array.isArray(pathCoords) ? 'array' : typeof pathCoords}`);
    console.log(`   pathCoords length: ${pathCoords?.length}`);
    if (pathCoords?.length > 0) {
      console.log(`   First coord: [${pathCoords[0]?.[0]?.toFixed(4)}, ${pathCoords[0]?.[1]?.toFixed(4)}]`);
      console.log(`   Last coord: [${pathCoords[pathCoords.length-1]?.[0]?.toFixed(4)}, ${pathCoords[pathCoords.length-1]?.[1]?.toFixed(4)}]`);
    }
    
    try {
      // 🔍 Test Turf operations that might fail
      const testLine = turf.lineString(pathCoords);
      console.log('✅ turf.lineString succeeded');
      
      const testLength = turf.length(testLine, { units: 'meters' });
      console.log(`✅ turf.length succeeded: ${testLength.toFixed(2)}m`);
    } catch (err) {
      console.error('❌ Turf operation failed:', err.message);
      console.error('   This is why the response fails!');
    }
    
    // 🔧 SAFELY build the response with coordinate validation
    let cleanPath;
    try {
      // Validate pathCoords before using Turf
      if (!Array.isArray(pathCoords) || pathCoords.length < 2) {
        throw new Error(`Invalid pathCoords: ${JSON.stringify(pathCoords)?.slice(0, 100)}`);
      }
      
      // Ensure all coordinates are valid numbers (not strings)
      cleanPath = pathCoords.map(coord => {
        if (!Array.isArray(coord) || coord.length < 2) {
          throw new Error(`Invalid coordinate in path: ${JSON.stringify(coord)}`);
        }
        return [
          typeof coord[0] === 'number' ? coord[0] : parseFloat(coord[0]),
          typeof coord[1] === 'number' ? coord[1] : parseFloat(coord[1])
        ];
      });
      
      const pathLine = turf.lineString(cleanPath);
      const totalLength = turf.length(pathLine, { units: 'meters' }).toFixed(2);
      
      const response = {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: cleanPath
        },
        properties: {
          length_meters: totalLength,
          buffer_applied: buffer,
          search_radius_km: searchRadiusKm,
          roads_considered: nearbyRoads.length,
          nodes_used: nodes.length,
          force_mode: forceMode,
          message: 'Path successfully computed!'
        }
      };
      
      console.log(`✅ Path found: ${totalLength}m`);
      console.log('✅ Response object built, sending to client...');
      return res.json(response);
      
    } catch (formatErr) {
      console.error('❌ Error formatting successful path:', formatErr.message);
      console.error('   pathCoords sample:', JSON.stringify(pathCoords)?.slice(0, 200));
      
      // Return a minimal success response even if formatting fails
      return res.json({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: pathCoords
        },
        properties: {
          length_meters: 'unknown',
          buffer_applied: buffer,
          message: 'Path found but length calculation failed',
          debug_error: formatErr.message
        }
      });
    }
    
  } catch (error) {
    // 🔴 CATCH-ALL: Handle unexpected errors
    console.error('❌ Server Error:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message,
      hint: 'Check server logs for details'
    });
  }
});

/**
 * 🌐 ROUTE: GET /api/mines/connectivity
 * 
 * 🎯 WHAT IT DOES:
 * Pre-computes connectivity status for all mines.
 * Helps frontend show which mines are easy to connect.
 * 
 * 📤 OUTPUT: Array of mine connectivity info
 */
app.get('/api/mines/connectivity', async (req, res) => {
  try {
    console.log('🔍 Pre-computing mine connectivity...');
    
    // Fetch all mines and roads (simplified for speed)
    const minesRes = await pool.query('SELECT gid, name, ST_AsGeoJSON(geom) AS geom FROM mines');
    const roadsRes = await pool.query('SELECT ST_AsGeoJSON(geom) AS geom FROM roads');
    
    const roads = roadsRes.rows.map(r => JSON.parse(r.geom));
    const results = [];
    
    for (const mineRow of minesRes.rows) {
      const mine = { gid: mineRow.gid, name: mineRow.name, geom: JSON.parse(mineRow.geom) };
      const mineCenter = turf.centerOfMass(mine).geometry.coordinates;
      
      // Quick distance check to nearest road (no obstacle avoidance)
      let minDist = Infinity;
      for (const road of roads) {
        try {
          const nearest = turf.nearestPointOnLine(road, turf.point(mineCenter));
          const dist = turf.distance(mineCenter, nearest.geometry.coordinates, { units: 'meters' });
          if (dist < minDist) minDist = dist;
        } catch {}
      }
      
      // Categorize by distance
      let status, color, hint;
      if (minDist <= 500) {
        status = 'easy';
        color = '#2ecc71'; // Green
        hint = 'Quick connection (<500m)';
      } else if (minDist <= 2000) {
        status = 'moderate';
        color = '#f39c12'; // Yellow
        hint = 'Moderate distance (500m-2km)';
      } else {
        status = 'hard';
        color = '#e74c3c'; // Red
        hint = `Isolated (${Math.round(minDist)}m to nearest road)`;
      }
      
      results.push({
        gid: mine.gid,
        name: mine.name,
        status,
        color,
        hint,
        distance_to_road_m: Math.round(minDist),
        center: mineCenter
      });
    }
    
    console.log(`✅ Connectivity computed for ${results.length} mines`);
    res.json({ mines: results, generated_at: new Date().toISOString() });
    
  } catch (error) {
    console.error('❌ Connectivity check failed:', error);
    res.status(500).json({ error: 'Failed to compute connectivity' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🌐 Server running on http://localhost:${PORT}`));