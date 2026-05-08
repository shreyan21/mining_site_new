// server.js
import express, { json } from 'express';
import cors from 'cors';
import { fetchSpatialData } from './database/db.js';
import { createSchoolBuffers, extractCorners, sampleRoadPoints } from './utils/geometry.js';
import { buildVisibilityEdges, runDijkstra } from './pathfinder/graph.js';
import * as turf from '@turf/turf'; 
import {pool} from './database/db.js';

const app = express();
app.use(cors()); // Allows frontend (OpenLayers) to call this API
app.use(json());

/**
 * 🌐 ROUTE: GET /api/connect
 * 
 * 📌 THIS IS WHERE EVERYTHING COMES TOGETHER.
 * 
 * FLOW EXPLAINED:
 * 1. Receive mineGid & buffer from user
 * 2. Fetch RAW data from PostGIS
 * 3. ⚡ TRANSFORM school points → buffered polygons (runtime!)
 * 4. Combine mines + rivers + buffered schools = ALL obstacles
 * 5. Generate graph nodes (Start, Bend, Goal)
 * 6. Build visibility edges (safe lines only)
 * 7. Run Dijkstra to find shortest path
 * 8. Return GeoJSON to frontend
 */

// server.js - Add this new route
app.get('/api/health', async (req, res) => {
  try {
    
    
    // Test connection
    await pool.query('SELECT 1');
    
    // Count records
    const counts = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM mines) as mines,
        (SELECT COUNT(*) FROM schools) as schools,
        (SELECT COUNT(*) FROM roads) as roads,
        (SELECT COUNT(*) FROM rivers) as rivers,
        (SELECT ST_SRID(geom) FROM schools LIMIT 1) as srid
    `);
    
    res.json({
      status: 'ok',
      database: counts.rows[0],
      message: 'All systems operational'
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/connect', async (req, res) => {
  try {
    const { mineGid, buffer } = req.query;
    if (!mineGid || !buffer) {
      return res.status(400).json({ error: 'Missing mineGid or buffer parameter' });
    }

    console.log(`🚀 Processing: Mine ${mineGid}, Buffer ${buffer}m`);

    const data = await fetchSpatialData(parseInt(mineGid));

    // 🛡️ Create school buffers
    const schoolBuffers = createSchoolBuffers(data.schools, parseInt(buffer));

    // 🚧 Combine obstacles
    const allObstacles = [
      ...data.obstacles.mines,
      ...data.obstacles.rivers,
      ...schoolBuffers.features
    ].filter(o => o?.geometry); // Remove nulls

    // 🎯 CRITICAL: Calculate bounding box around mine + nearby roads
    // This limits graph building to relevant area (10km buffer)
   // server.js - REPLACE the node generation section with this OPTIMIZED version

    // 🎯 AGGRESSIVE bounding box: only 2km around mine (not 10km)
    const mineBbox = turf.bbox(data.mine);
    const [minX, minY, maxX, maxY] = mineBbox;
    const padding = 0.02; // ~2km in degrees at this latitude (was 0.1)
    const searchBbox = [
      minX - padding, minY - padding,
      maxX + padding, maxY + padding
    ];
    console.log(`🔍 Search bounding box (2km): [${searchBbox.map(c=>c.toFixed(4)).join(', ')}]`);

    // 📍 Generate nodes WITH aggressive filtering
    let nodeCounter = 0;
    
    // START: Mine corners (always include all)
    const startNodes = extractCorners([data.mine], 'start', nodeCounter);
    nodeCounter += startNodes.length;

    // BEND: Only obstacle corners VERY close to mine
    const nearbyObstacles = allObstacles.filter(obs => {
      try {
        const obsBbox = turf.bbox(obs);
        // Check if obstacle bbox overlaps search bbox
        return !(obsBbox[2] < searchBbox[0] || obsBbox[0] > searchBbox[2] ||
                 obsBbox[3] < searchBbox[1] || obsBbox[1] > searchBbox[3]);
      } catch { return false; }
    });
    
    // 🔧 FURTHER FILTER: Only keep obstacles within 1km of mine center
    const mineCenter = turf.centerOfMass(data.mine).geometry.coordinates;
    const veryNearObstacles = nearbyObstacles.filter(obs => {
      try {
        const obsCenter = turf.centerOfMass(obs).geometry.coordinates;
        const dist = turf.distance(mineCenter, obsCenter, { units: 'kilometers' });
        return dist <= 1.0; // Only obstacles within 1km
      } catch { return false; }
    });
    console.log(`🧱 Using ${veryNearObstacles.length} of ${allObstacles.length} obstacles (1km filter)`);
    
    const bendNodes = extractCorners(veryNearObstacles, 'bend', nodeCounter);
    nodeCounter += bendNodes.length;

    // GOAL: Sample roads SPARSELY (200m intervals) and only very nearby
    const nearbyRoads = data.roads.filter(road => {
      try {
        const roadBbox = turf.bbox(road);
        return !(roadBbox[2] < searchBbox[0] || roadBbox[0] > searchBbox[2] ||
                 roadBbox[3] < searchBbox[1] || roadBbox[1] > searchBbox[3]);
      } catch { return false; }
    });
    
    // 🔧 AGGRESSIVE ROAD FILTER: Only roads within 1.5km of mine
    const veryNearRoads = nearbyRoads.filter(road => {
      try {
        const roadCenter = turf.centerOfMass(road).geometry.coordinates;
        const dist = turf.distance(mineCenter, roadCenter, { units: 'kilometers' });
        return dist <= 1.5;
      } catch { return false; }
    });
    console.log(`🛣️ Sampling ${veryNearRoads.length} of ${data.roads.length} roads (1.5km filter)`);
    
    // 🔧 SPARSE SAMPLING: 200m intervals (not 50m) for speed
    const goalNodes = sampleRoadPoints(veryNearRoads, 200, nodeCounter);
    
    const nodes = [...startNodes, ...bendNodes, ...goalNodes];
    console.log(`⚙️ Built graph with ${nodes.length} nodes (target: <2000)`);

    // 🕸️ Build edges WITH distance threshold (skip far-apart nodes)
    const edges = buildVisibilityEdges(nodes, allObstacles, searchBbox, 2000); // 2km max edge length
    // 🧭 Run Dijkstra
    console.log('🔍 Finding shortest safe path...');
    const pathCoords = runDijkstra(nodes, edges);

    if (!pathCoords) {
      return res.status(404).json({ 
        error: 'No safe path found.', 
        hint: 'Try reducing buffer or selecting a different mine.' 
      });
    }

    // Return result
    const response = {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: pathCoords },
      properties: {
        length_meters: pathCoords.length * 111000 / Math.cos(pathCoords[0][1] * Math.PI/180), // rough
        buffer_applied: buffer,
        nodes_used: nodes.length,
        edges_used: edges.length
      }
    };

    res.json(response);

  } catch (error) {
    console.error('❌ Server Error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});
// const PORT = process.env.PORT || 3000;
app.listen(4000, () => console.log(`🌐 Server running on http://localhost:4000`));