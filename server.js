// server.js
import express from 'express';
import cors from 'cors';
import * as turf from '@turf/turf';

// ✅ FIX 1: Import pool from database module
import { fetchSpatialData, pool } from './database/db.js';
import { createSchoolBuffers, extractCorners, sampleRoadPoints } from './utils/geometry.js';
import { buildVisibilityEdges, runDijkstra } from './pathfinder/graph.js';

/**
 * 🔧 HELPER: Clean geometry for Turf.js compatibility
 * Handles MultiPolygonZM, removes Z/M dimensions, ensures valid GeoJSON
 */
function cleanGeometryForTurf(geom) {
  if (!geom?.type || !geom?.coordinates) return null;
  
  // Handle Multi* geometries: take the largest part
  if (geom.type.startsWith('Multi')) {
    const simpleType = geom.type.replace('Multi', '');
    const parts = geom.coordinates;
    const largest = parts.reduce((a, b) => {
      const countA = Array.isArray(a) ? a.flat(Infinity).filter(c => typeof c === 'number').length : 0;
      const countB = Array.isArray(b) ? b.flat(Infinity).filter(c => typeof c === 'number').length : 0;
      return countA > countB ? a : b;
    });
    geom = { type: simpleType, coordinates: largest };
  }
  
  // Remove Z/M dimensions: keep only [lon, lat]
  if (Array.isArray(geom.coordinates)) {
    const cleanCoords = geom.coordinates.map(ring => {
      if (Array.isArray(ring)) {
        return ring.map(coord => {
          if (Array.isArray(coord) && coord.length >= 2) {
            return [Number(coord[0]), Number(coord[1])];
          }
          return coord;
        });
      }
      return ring;
    });
    geom = { ...geom, coordinates: cleanCoords };
  }
  
  // Validate coordinates are in degree range (not meters)
  const firstCoord = geom.coordinates?.[0]?.[0];
  if (firstCoord && (Math.abs(firstCoord[0]) > 180 || Math.abs(firstCoord[1]) > 90)) {
    throw new Error('Coordinates appear to be in meters, not degrees');
  }
  
  return geom;
}

const app = express();
app.use(cors());
app.use(express.json());

const SCHOOL_DISTRICT_COORDS = {
  Azamgarh: [83.1846, 26.0739],
  Deoria: [83.7870, 26.5017],
  Gorakhpur: [83.3732, 26.7606],
  'Kushi Nagar': [83.9823, 26.7399],
  Maharajganj: [83.5654, 27.1446],
  Mau: [83.5611, 25.9417],
  'Sant Kabir Nagar': [83.0629, 26.7906],
  'Siddharth Nagar': [83.0718, 27.2716],
};

function schoolDisplayGeometry(row, index) {
  const districtCenter = SCHOOL_DISTRICT_COORDS[row.field3];
  if (!districtCenter) return JSON.parse(row.geom);

  const angle = index * 2.399963229728653;
  const radius = 0.006 + (index % 12) * 0.0025;
  return {
    type: 'Point',
    coordinates: [
      districtCenter[0] + Math.cos(angle) * radius,
      districtCenter[1] + Math.sin(angle) * radius,
    ],
  };
}

/**
 * 🌐 ROUTE: GET /api/connect
 * Main endpoint for finding mine-to-road paths
 */
app.get('/api/connect', async (req, res) => {
  const { mineGid, buffer, force } = req.query;
  const forceMode = force === 'true';
  
  console.log(`🔧 Force mode: ${forceMode ? 'ENABLED' : 'disabled'}`);
  
  // Adaptive parameters based on force mode
  const params = {
    searchRadiusKm: forceMode ? 25 : 2,
    maxSearchRadiusKm: forceMode ? 50 : 15,
    radiusStep: forceMode ? 5 : 3,
    cornerLimitPerObstacle: forceMode ? 25 : 8,
    roadSamplingInterval: forceMode ? 100 : 300,
    maxRoadPointsPerRoad: forceMode ? 50 : 20,
    maxEdgeMeters: forceMode ? 20000 : 5000,
    obstacleFilterPadding: forceMode ? 0.05 : 0.02
  };
  
  console.log(`📐 Using params: search=${params.searchRadiusKm}km, corners=${params.cornerLimitPerObstacle}`);
  
  if (!mineGid || !buffer) {
    return res.status(400).json({ error: 'Missing mineGid or buffer parameter' });
  }
  
  console.log(`🚀 Processing: Mine ${mineGid}, Buffer ${buffer}m`);
  
  try {
    // Fetch data from database
    const data = await fetchSpatialData(parseInt(mineGid));
    
    // Create school buffers with user input
    const schoolBuffers = createSchoolBuffers(
      data.schools.map(s => s),
      parseInt(buffer)
    );
    
    // Combine all obstacles
    const allObstacles = [
      ...data.obstacles.mines,
      ...data.obstacles.rivers,
      ...schoolBuffers.features
    ].filter(o => o?.geometry);
    
    // Calculate mine bounding box
    const mineBbox = turf.bbox(data.mine);
    
    // Find nearby roads with progressive expansion
    let searchRadiusKm = params.searchRadiusKm;
    let nearbyRoads = [];
    const mineCenter = turf.centerOfMass(data.mine).geometry.coordinates;
    
    console.log(`🔍 Searching for roads near mine (center: [${mineCenter.map(c => c.toFixed(4)).join(', ')}])`);
    
    while (searchRadiusKm <= params.maxSearchRadiusKm) {
      console.log(`🔄 Attempt ${searchRadiusKm}km radius...`);
      
      nearbyRoads = data.roads.filter(road => {
        try {
          const roadGeom = road.geometry || road;
          const nearest = turf.nearestPointOnLine(roadGeom, turf.point(mineCenter));
          const dist = turf.distance(mineCenter, nearest.geometry.coordinates, { units: 'kilometers' });
          return dist <= searchRadiusKm;
        } catch {
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
      if (nearbyRoads.length > 0) break;
      searchRadiusKm += params.radiusStep;
    }
    
    if (nearbyRoads.length === 0) {
      console.error(`❌ No roads found within ${params.maxSearchRadiusKm}km of mine #${mineGid}`);
      return res.status(404).json({ 
        error: 'No roads accessible', 
        hint: `Mine is isolated. Nearest road may be >${params.maxSearchRadiusKm}km away.`,
        mine_center: mineCenter,
        suggestion: 'Verify road data coverage or select a different mine',
        retry_url: !forceMode ? `/api/connect?mineGid=${mineGid}&buffer=${buffer}&force=true` : null
      });
    }
    
    console.log(`✅ Using ${nearbyRoads.length} roads for pathfinding`);
    
    // Filter nearby obstacles
    const padding = params.obstacleFilterPadding;
    const nearbyObstacles = allObstacles.filter(obs => {
      try {
        const obsBbox = turf.bbox(obs);
        return !(obsBbox[2] < mineBbox[0] - padding || obsBbox[0] > mineBbox[2] + padding ||
                 obsBbox[3] < mineBbox[1] - padding || obsBbox[1] > mineBbox[3] + padding);
      } catch { return false; }
    });
    console.log(`🧱 Using ${nearbyObstacles.length} of ${allObstacles.length} obstacles`);
    
    // Generate graph nodes
    let nodeCounter = 0;
    const startNodes = extractCorners([data.mine], 'start', nodeCounter);
    nodeCounter += startNodes.length;
    
    const bendNodes = extractCorners(nearbyObstacles, 'bend', nodeCounter, params.cornerLimitPerObstacle);
    nodeCounter += bendNodes.length;
    
    const goalNodes = sampleRoadPoints(nearbyRoads, params.roadSamplingInterval, nodeCounter, params.maxRoadPointsPerRoad);
    const nodes = [...startNodes, ...bendNodes, ...goalNodes];
    
    const startCount = nodes.filter(n => n.type === 'start').length;
    const goalCount = nodes.filter(n => n.type === 'goal').length;
    const bendCount = nodes.filter(n => n.type === 'bend').length;
    console.log(`📊 Node breakdown: start=${startCount}, bend=${bendCount}, goal=${goalCount}`);
    console.log(`⚙️ Built graph with ${nodes.length} nodes`);
    
    // Build visibility graph
    const edges = buildVisibilityEdges(nodes, allObstacles, null, params.maxEdgeMeters);
    
    // Run Dijkstra
    console.log('🔍 Finding shortest safe path...');
    const pathCoords = runDijkstra(nodes, edges);
    
    // Emergency fallback if pathfinding fails
    if (!pathCoords) {
      console.log('⚠️ Complex pathfinding failed. Trying emergency straight-line fallback...');
      
      try {
        let bestPoint = null;
        let bestDist = Infinity;
        
        for (const road of data.roads) {
          try {
            const nearest = turf.nearestPointOnLine(road, turf.point(mineCenter));
            const dist = turf.distance(mineCenter, nearest.geometry.coordinates, { units: 'meters' });
            if (dist < bestDist) {
              bestDist = dist;
              bestPoint = nearest.geometry.coordinates;
            }
          } catch {}
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
      
      // Analyze failure and return helpful error
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
        analysis.suggestion = 'Try increasing search radius or verify road data coverage';
      } else if (goalCount === 0) {
        analysis.possible_reasons.push('No road sample points generated');
        analysis.suggestion = 'Try reducing road sampling interval or check road geometry validity';
      } else if (edges.length === 0) {
        analysis.possible_reasons.push('No safe edges could be created');
        analysis.suggestion = 'Obstacles may completely block access. Try reducing buffer or enabling force mode';
      } else {
        analysis.possible_reasons.push('Dijkstra could not find a path through available edges');
        analysis.suggestion = 'Graph may be disconnected. Try enabling force mode for relaxed constraints';
      }
      
      if (!forceMode) {
        analysis.suggestion += ' OR retry with ?force=true to relax constraints';
      }
      
      console.error(`❌ Path failed for mine ${mineGid}:`, analysis.possible_reasons.join('; '));
      
      return res.status(404).json({ 
        error: 'No safe path found', 
        hint: analysis.suggestion,
        debug: analysis,
        retry_url: !forceMode ? `/api/connect?mineGid=${mineGid}&buffer=${buffer}&force=true` : null
      });
    }
    
    // Build successful response
    console.log('🔍 DEBUG: Preparing response...');
    
    try {
      // Validate and clean path coordinates
      if (!Array.isArray(pathCoords) || pathCoords.length < 2) {
        throw new Error(`Invalid pathCoords: ${JSON.stringify(pathCoords)?.slice(0, 100)}`);
      }
      
      const cleanPath = pathCoords.map(coord => {
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
      return res.json(response);
      
    } catch (formatErr) {
      console.error('❌ Error formatting successful path:', formatErr.message);
      // Return minimal response even if formatting fails
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
 * Pre-computes connectivity status for all mines
 */
// server.js - UPDATE /api/mines/connectivity route
/**
 * 🌐 ROUTE: GET /api/mines/connectivity
 * 🎯 Pre-computes connectivity status for all mines (LIGHTWEIGHT)
 */
app.get('/api/mines/connectivity', async (req, res) => {
  try {
    console.log('Pre-computing mine connectivity with PostGIS...');

    const minesRes = await pool.query(`
      SELECT
        m.gid,
        m.name,
        ST_X(ST_PointOnSurface(m.geom)) AS lon,
        ST_Y(ST_PointOnSurface(m.geom)) AS lat,
        COALESCE(nearest.distance_m, 0) AS distance_to_road_m
      FROM mines m
      LEFT JOIN LATERAL (
        SELECT ST_Distance(m.geom::geography, r.geom::geography) AS distance_m
        FROM roads r
        ORDER BY m.geom <-> r.geom
        LIMIT 1
      ) nearest ON true
      WHERE m.name NOT ILIKE '%brick%'
      AND m.name NOT ILIKE '%kiln%'
    `);

    const results = minesRes.rows.map((mineRow) => {
      const minDist = Number(mineRow.distance_to_road_m);
      let status, color, hint;

      if (minDist <= 500) {
        status = 'easy'; color = '#2ecc71'; hint = 'Quick connection (<500m)';
      } else if (minDist <= 2000) {
        status = 'moderate'; color = '#f39c12'; hint = 'Moderate distance (500m-2km)';
      } else {
        status = 'hard'; color = '#e74c3c'; hint = `Isolated (${Math.round(minDist)}m to nearest road)`;
      }

      return {
        gid: mineRow.gid,
        name: mineRow.name,
        status,
        color,
        hint,
        distance_to_road_m: Math.round(minDist),
        center: [Number(mineRow.lon), Number(mineRow.lat)]
      };
    });

    console.log(`Connectivity computed for ${results.length} mines`);
    res.json({ mines: results, generated_at: new Date().toISOString() });
  } catch (error) {
    console.error('Connectivity check failed:', error);
    res.status(500).json({ error: 'Failed to compute connectivity' });
  }
});

app.get('/api/mines/connectivity-old', async (req, res) => {
  try {
    console.log('🔍 Pre-computing mine connectivity...');
    
    // ✅ FIX: Filter out brick fields + ONLY select needed columns
    const minesRes = await pool.query(`
      SELECT gid, name, ST_AsGeoJSON(ST_Centroid(geom)) AS center_geom
      FROM mines 
      WHERE name NOT ILIKE '%brick%' 
      AND name NOT ILIKE '%kiln%'
    `);
    
    const roadsRes = await pool.query('SELECT ST_AsGeoJSON(geom) AS geom FROM roads');
    const roads = roadsRes.rows.map(r => JSON.parse(r.geom));
    const results = [];
    
    for (const mineRow of minesRes.rows) {
      // Parse center point (much smaller than full geometry)
      const centerGeom = JSON.parse(mineRow.center_geom);
      const mineCenter = centerGeom.coordinates; // [lon, lat]
      
      // Quick distance check to nearest road
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
        status = 'easy'; color = '#2ecc71'; hint = 'Quick connection (<500m)';
      } else if (minDist <= 2000) {
        status = 'moderate'; color = '#f39c12'; hint = 'Moderate distance (500m-2km)';
      } else {
        status = 'hard'; color = '#e74c3c'; hint = `Isolated (${Math.round(minDist)}m to nearest road)`;
      }
      
      // ✅ ONLY return lightweight data (NO full geometry)
      results.push({
        gid: mineRow.gid,
        name: mineRow.name,
        status,
        color,
        hint,
        distance_to_road_m: Math.round(minDist),
        center: mineCenter
        // ❌ REMOVED: geometry: cleanGeom  ← This was causing 2MB+ responses!
      });
    }
    
    console.log(`✅ Connectivity computed for ${results.length} mines (lightweight)`);
    res.json({ mines: results, generated_at: new Date().toISOString() });
    
  } catch (error) {
    console.error('❌ Connectivity check failed:', error);
    res.status(500).json({ error: 'Failed to compute connectivity' });
  }
});
/**
 * 🌐 ROUTE: GET /api/mine/:gid
 * 🎯 Returns full geometry for a SINGLE mine (when user clicks it)
 */
app.get('/api/mine/:gid', async (req, res) => {
  try {
    const { gid } = req.params;
    
    const mineRes = await pool.query(`
      SELECT gid, name, ST_AsGeoJSON(geom) AS geom
      FROM mines 
      WHERE gid = $1
      AND name NOT ILIKE '%brick%' 
      AND name NOT ILIKE '%kiln%'
    `, [gid]);
    
    if (mineRes.rows.length === 0) {
      return res.status(404).json({ error: 'Mine not found' });
    }
    
    const row = mineRes.rows[0];
    res.json({
      gid: row.gid,
      name: row.name,
      geometry: JSON.parse(row.geom) // Full geometry, but only for 1 mine
    });
    
  } catch (error) {
    console.error('❌ Failed to fetch mine:', error);
    res.status(500).json({ error: 'Failed to fetch mine' });
  }
});
/**
 * 🌐 ROUTE: GET /api/obstacles
 * Returns schools and rivers for frontend display
 */
/**
 * 🌐 ROUTE: GET /api/obstacles
 * 🎯 Returns schools and rivers (LIGHTWEIGHT)
 */
app.get('/api/obstacles', async (req, res) => {
  try {
    const schoolsRes = await pool.query(`
      SELECT gid, field3, field7, ST_AsGeoJSON(ST_PointOnSurface(geom), 6) AS geom
      FROM schools
    `);

    const riversRes = await pool.query(`
      SELECT
        gid,
        wetname,
        ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, 0.005), 5) AS geom
      FROM rivers
    `);

    res.json({
      schools: schoolsRes.rows.map((r, index) => ({
        gid: r.gid,
        type: 'school',
        name: r.field7,
        district: r.field3,
        geometry: schoolDisplayGeometry(r, index)
      })),
      rivers: riversRes.rows.map((r) => ({
        gid: r.gid,
        name: r.wetname,
        type: 'river',
        geometry: JSON.parse(r.geom)
      }))
    });
  } catch (error) {
    console.error('Failed to fetch obstacles:', error);
    res.status(500).json({ error: 'Failed to fetch obstacles' });
  }
});

app.get('/api/obstacles-old', async (req, res) => {
  try {
    const schoolsRes = await pool.query('SELECT gid, ST_AsGeoJSON(geom) AS geom FROM schools');
    // ✅ ST_Simplify reduces river complexity while keeping shape recognizable
    const riversRes = await pool.query(`
      SELECT gid, wetname, ST_AsGeoJSON(ST_Simplify(geom, 0.0001)) AS geom FROM rivers
    `);
    
    res.json({
      schools: schoolsRes.rows.map(r => ({ gid: r.gid, type: 'school', geometry: JSON.parse(r.geom) })),
      rivers: riversRes.rows.map(r => ({ gid: r.gid, name: r.wetname, type: 'river', geometry: JSON.parse(r.geom) }))
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch obstacles' });
  }
});

app.get('/api/roads', async (req, res) => {
  try {
    const roadsRes = await pool.query(`
      SELECT gid, ST_AsGeoJSON(ST_Simplify(geom, 0.0005), 6) AS geom
      FROM roads
    `);

    res.json({
      roads: roadsRes.rows.map((r) => ({
        gid: r.gid,
        geometry: JSON.parse(r.geom),
      })),
    });
  } catch (error) {
    console.error('Failed to fetch roads:', error);
    res.status(500).json({ error: 'Failed to fetch roads' });
  }
});
app.get('/api/roads', async (req, res) => {
  try {
    // ST_Simplify reduces vertex count while keeping shape recognisable.
    // Tolerance 0.00005 ≈ ~5m at equator — adjust to taste.
    const result = await pool.query(`
      SELECT gid, ST_AsGeoJSON(ST_Simplify(geom, 0.00005)) AS geom
      FROM roads
    `);

    res.json({
      roads: result.rows.map(r => ({
        gid:      r.gid,
        geometry: JSON.parse(r.geom),
      })),
    });
  } catch (error) {
    console.error('❌ Failed to fetch roads:', error);
    res.status(500).json({ error: 'Failed to fetch roads' });
  }
});


const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🌐 Server running on http://localhost:${PORT}`));
