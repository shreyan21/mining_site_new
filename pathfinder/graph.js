// pathfinder/graph.js
import { 
  lineString, 
  booleanDisjoint, 
  bbox, 
  centerOfMass,
  distance 
} from '@turf/turf';

/**
 * 🔧 HELPER: Safe booleanDisjoint with error handling
 */
function safeBooleanDisjoint(geomA, geomB) {
  try {
    if (!geomA?.type || !geomB?.type) return false;
    return booleanDisjoint(geomA, geomB);
  } catch (err) {
    console.warn('⚠️ booleanDisjoint error, blocking edge:', err.message);
    return false;
  }
}

/**
 * 🕸️ buildVisibilityEdges(nodes, allObstacles, boundingBox, maxEdgeMeters)
 */
function buildVisibilityEdges(nodes, allObstacles, boundingBox = null, maxEdgeMeters = 5000) {
  const edges = [];
  
  // Pre-compute clean obstacles
  const cleanObstacles = allObstacles
    .map(obs => {
      const geom = obs.geometry || obs;
      if (!geom?.type) return null;
      
      try {
        const obsBbox = bbox(geom);
        const centroid = centerOfMass(geom).geometry.coordinates;
        
        return {
          geometry: geom,
          bbox: obsBbox,
          centroid,
          bboxSize: Math.sqrt(
            Math.pow(obsBbox[2] - obsBbox[0], 2) + 
            Math.pow(obsBbox[3] - obsBbox[1], 2)
          )
        };
      } catch (err) {
        console.warn(`⚠️ Skipping invalid obstacle: ${err.message}`);
        return null;
      }
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

  console.log(`🔍 Building edges for ${filteredNodes.length} nodes, ${cleanObstacles.length} obstacles`);

  // Build edges with spatial filtering
  let safeCount = 0;
  for (let i = 0; i < filteredNodes.length; i++) {
    if (i % 200 === 0 && i > 0) {
      console.log(`⏳ Progress: ${i}/${filteredNodes.length} nodes processed`);
    }
    
    for (let j = i + 1; j < filteredNodes.length; j++) {
      const nodeA = filteredNodes[i];
      const nodeB = filteredNodes[j];
      
      // ✅ FIX: Removed space in variable name
      const dx = nodeA.coord[0] - nodeB.coord[0];
      const dy = nodeA.coord[1] - nodeB.coord[1];
      const approxDistMeters = Math.sqrt(dx*dx + dy*dy) * 111000; // ✅ FIX: Removed space in number
      
      if (approxDistMeters > maxEdgeMeters) continue; // ✅ FIX: Removed space in variable name
      
      const line = lineString([nodeA.coord, nodeB.coord]);
      const lineBbox = bbox(line);
      const lineCenter = [
        (nodeA.coord[0] + nodeB.coord[0]) / 2, 
        (nodeA.coord[1] + nodeB.coord[1]) / 2
      ];
      
      let isSafe = true;
      
      // ✅ FIX: Removed space in 'for' keyword
      for (const obstacle of cleanObstacles) {
        // Quick reject #1: Bounding boxes don't overlap
        if (lineBbox[2] < obstacle.bbox[0] - 0.01 || 
            lineBbox[0] > obstacle.bbox[2] + 0.01 ||
            lineBbox[3] < obstacle.bbox[1] - 0.01 || 
            lineBbox[1] > obstacle.bbox[3] + 0.01) {
          continue;
        }
        
        // Quick reject #2: Line center far from obstacle centroid
        const centerDist = Math.sqrt(
          Math.pow(lineCenter[0] - obstacle.centroid[0], 2) + 
          Math.pow(lineCenter[1] - obstacle.centroid[1], 2)
        ) * 111000;
        
        if (centerDist > (obstacle.bboxSize * 111000) + approxDistMeters + 100) {
          continue;
        }
        
        // Expensive booleanDisjoint check
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
 */
function runDijkstra(nodes, edges) {
  console.log(`🧭 Dijkstra starting: ${nodes.length} nodes, ${edges.length} edges`);
  console.log(`   Start nodes: ${nodes.filter(n => n.type === 'start').length}`);
  console.log(`   Goal nodes: ${nodes.filter(n => n.type === 'goal').length}`);

  const hasGoals = nodes.some(n => n.type === 'goal');
  if (!hasGoals) {
    console.warn('⚠️ No goal nodes (road samples) in graph - cannot find path');
    return null;
  }
  
  const hasStarts = nodes.some(n => n.type === 'start');
  if (!hasStarts) {
    console.warn('⚠️ No start nodes (mine corners) in graph');
    return null;
  }

  const startIds = new Set(nodes.filter(n => n.type === 'start').map(n => n.id));
  const goalIds = new Set(nodes.filter(n => n.type === 'goal').map(n => n.id));
  
  let startConnectedToGoal = false;
  for (const edge of edges) {
    if ((startIds.has(edge.from) && goalIds.has(edge.to)) ||
        (startIds.has(edge.to) && goalIds.has(edge.from))) {
      startConnectedToGoal = true;
      break;
    }
  }
  console.log(`   🔗 Start directly connected to goal: ${startConnectedToGoal}`);
  
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

/**
 * 🔙 reconstructPath(prev, endNode, allNodes)
 */
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