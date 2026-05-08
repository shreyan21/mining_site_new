// pathfinder/graph.js - WITH SAFEGUARDS
import { lineString, booleanDisjoint, bbox } from '@turf/turf';

/**
 * 🔧 HELPER: Check if two geometries are disjoint (with error handling)
 */
function safeBooleanDisjoint(geomA, geomB) {
  try {
    // Ensure both are valid GeoJSON objects
    if (!geomA?.type || !geomB?.type) return false;
    return booleanDisjoint(geomA, geomB);
  } catch (err) {
    // If Turf fails, assume NOT disjoint (safer to block the edge)
    console.warn('⚠️ booleanDisjoint error, blocking edge:', err.message);
    return false;
  }
}


function buildVisibilityEdges(nodes, allObstacles, boundingBox = null, maxEdgeMeters = 5000) {
  const edges = [];
  
  // Pre-clean obstacles
  const cleanObstacles = allObstacles
    .map(obs => {
      const geom = obs.geometry || obs;
      return geom?.type ? { type: 'Feature', geometry: geom } : null;
    })
    .filter(o => o !== null);

  // Filter nodes to bounding box
  const filteredNodes = boundingBox 
    ? nodes.filter(n => {
        const [minX, minY, maxX, maxY] = boundingBox;
        const [x, y] = n.coord;
        return x >= minX && x <= maxX && y >= minY && y <= maxY;
      })
    : nodes;

  console.log(`🔍 Building edges for ${filteredNodes.length} nodes (max edge: ${maxEdgeMeters}m)`);

  // Build edges with EARLY EXIT for distant pairs
  let safeCount = 0;
  for (let i = 0; i < filteredNodes.length; i++) {
    if (i % 500 === 0 && i > 0) {
      console.log(`⏳ Progress: ${i}/${filteredNodes.length} nodes, ${safeCount} edges`);
    }
    
    for (let j = i + 1; j < filteredNodes.length; j++) {
      const nodeA = filteredNodes[i];
      const nodeB = filteredNodes[j];
      
      // ✅ QUICK DISTANCE CHECK: Skip if too far (in degrees ≈ meters/111000)
      const dx = nodeA.coord[0] - nodeB.coord[0];
      const dy = nodeA.coord[1] - nodeB.coord[1];
      const approxDistMeters = Math.sqrt(dx*dx + dy*dy) * 111000;
      
      if (approxDistMeters > maxEdgeMeters) continue; // Skip long edges
      
      const line = lineString([nodeA.coord, nodeB.coord]);
      
      // Check against obstacles (with early exit)
      let isSafe = true;
      for (const obstacle of cleanObstacles) {
        if (!safeBooleanDisjoint(line, obstacle.geometry)) {
          isSafe = false;
          break;
        }
      }
      
      if (isSafe) {
        edges.push({
          from: nodeA.id,
          to: nodeB.id,
          weight: approxDistMeters,
          geometry: line.geometry
        });
        safeCount++;
      }
    }
  }

  console.log(`✅ Created ${edges.length} safe edges`);
  return edges;
}

/**
 * 🧭 runDijkstra(nodes, edges)
 * (Unchanged from before - works correctly)
 */
function runDijkstra(nodes, edges) {
  const adj = {};
  nodes.forEach(n => adj[n.id] = []);
  edges.forEach(e => {
    adj[e.from].push({ to: e.to, weight: e.weight });
    adj[e.to].push({ to: e.from, weight: e.weight });
  });

  const dist = {};
  const prev = {};
  const visited = new Set();
  
  nodes.forEach(n => dist[n.id] = Infinity);
  const startNodes = nodes.filter(n => n.type === 'start');
  startNodes.forEach(n => dist[n.id] = 0);

  while (true) {
    let currentId = null;
    let minDist = Infinity;

    for (const id in dist) {
      if (!visited.has(id) && dist[id] < minDist) {
        minDist = dist[id];
        currentId = id;
      }
    }

    if (currentId === null) return null;
    visited.add(currentId);

    const currentNode = nodes.find(n => n.id == currentId);
    if (currentNode?.type === 'goal') {
      return reconstructPath(prev, currentNode, nodes);
    }

    const neighbors = adj[currentId] || [];
    neighbors.forEach(neighbor => {
      if (!visited.has(neighbor.to)) {
        const newDist = dist[currentId] + neighbor.weight;
        if (newDist < dist[neighbor.to]) {
          dist[neighbor.to] = newDist;
          prev[neighbor.to] = currentId;
        }
      }
    });
  }
}

function reconstructPath(prev, endNode, allNodes) {
  const path = [endNode.coord];
  let currentId = endNode.id;

  while (prev[currentId] !== undefined) {
    currentId = prev[currentId];
    const node = allNodes.find(n => n.id == currentId);
    if (node?.coord) path.push(node.coord);
  }

  return path.reverse();
}

export { buildVisibilityEdges, runDijkstra };