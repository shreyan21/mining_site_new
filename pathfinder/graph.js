// pathfinder/graph.js
import { 
  lineString, 
  booleanDisjoint, 
  bbox, 
  centerOfMass,
  distance 
} from '@turf/turf';

/**
 * 📌 WHAT THIS FILE DOES:
 * Implements the Visibility Graph + Dijkstra algorithm.
 * This is the core mathematical engine that finds the shortest safe path.
 * 
 * 🔑 KEY POINT: This file doesn't know about databases or users.
 * It just takes nodes + edges + obstacles and returns a path.
 */

/**
 * 🔧 HELPER: Safe booleanDisjoint with error handling
 * 
 * 🎯 WHAT IT DOES:
 * Wraps Turf's booleanDisjoint to prevent crashes on invalid geometry.
 * If Turf fails, we assume the edge is NOT safe (conservative approach).
 * 
 * 📥 INPUT: Two GeoJSON geometry objects
 * 📤 OUTPUT: boolean - true if geometries do NOT intersect (safe to use)
 */
function safeBooleanDisjoint(geomA, geomB) {
  try {
    if (!geomA?.type || !geomB?.type) return false;
    return booleanDisjoint(geomA, geomB);
  } catch (err) {
    // If Turf fails, assume NOT disjoint (safer to block the edge)
    console.warn('⚠️ booleanDisjoint error, blocking edge:', err.message);
    return false;
  }
}

/**
 * 🕸️ buildVisibilityEdges(nodes, allObstacles, boundingBox, maxEdgeMeters)
 * 
 * 🎯 WHAT IT DOES:
 * Connects every pair of nodes with a straight line IF the line is SAFE.
 * "Safe" means the line does NOT intersect any obstacle polygon.
 * 
 * 🧒 SIMPLE EXPLANATION:
 * Imagine you have dots on paper (nodes) and shapes you can't touch (obstacles)
 * You try to draw a straight line between every pair of dots ✏️
 * If the line touches a shape → erase it ❌
 * If the line is clear → keep it ✅ and write its length on it
 * 
 * 📥 INPUT: 
 *   • nodes: Array of { id, type, coord: [lon, lat] }
 *   • allObstacles: Array of GeoJSON obstacle features
 *   • boundingBox: [minX, minY, maxX, maxY] - only check nodes in this area (or null for all)
 *   • maxEdgeMeters: Number - skip edges longer than this (performance optimization)
 * 📤 OUTPUT: Array of edges { from, to, weight, geometry }
 * 
 * 🔑 WHY THIS IS THE HEAVY LIFTER:
 * This function checks EVERY pair of nodes against EVERY obstacle
 * For 1,000 nodes → ~500,000 pairs → each checked against 100 obstacles
 * That's 50 MILLION checks! So we use spatial filtering to reduce work.
 */
function buildVisibilityEdges(nodes, allObstacles, boundingBox = null, maxEdgeMeters = 5000) {
  const edges = [];
  
  // 🔧 STEP 1: PRE-COMPUTE - Clean and enrich obstacles for fast filtering
  // This runs ONCE, then we reuse the data thousands of times
  const cleanObstacles = allObstacles
    .map(obs => {
      // Handle both { geometry: {...} } and raw {...} formats
      const geom = obs.geometry || obs;
      
      // Validate: Must have type and coordinates
      if (!geom?.type) return null;
      
      try {
        // Pre-compute spatial metadata for fast rejection later
        const obsBbox = bbox(geom);
        const centroid = centerOfMass(geom).geometry.coordinates;
        
        return {
          geometry: geom,                    // The actual shape for intersection checks
          bbox: obsBbox,                     // [minLon, minLat, maxLon, maxLat] for quick bbox checks
          centroid,                          // [lon, lat] center point for distance checks
          bboxSize: Math.sqrt(               // Pre-computed diagonal size for filtering
            Math.pow(obsBbox[2] - obsBbox[0], 2) + 
            Math.pow(obsBbox[3] - obsBbox[1], 2)
          )
        };
      } catch (err) {
        // If any Turf operation fails, skip this obstacle
        console.warn(`⚠️ Skipping invalid obstacle: ${err.message}`);
        return null;
      }
    })
    .filter(o => o !== null);  // Remove all null/invalid entries

  // 🔧 STEP 2: Filter nodes to bounding box (if provided) for performance
  const filteredNodes = boundingBox 
    ? nodes.filter(n => {
        const [minX, minY, maxX, maxY] = boundingBox;
        const [x, y] = n.coord;
        return x >= minX && x <= maxX && y >= minY && y <= maxY;
      })
    : nodes;

  console.log(`🔍 Building edges for ${filteredNodes.length} nodes, ${cleanObstacles.length} obstacles`);

  // 🔧 STEP 3: Build edges with OPTIMIZED obstacle checking
  let safeCount = 0;
  
  for (let i = 0; i < filteredNodes.length; i++) {
    // Progress logging for long-running operations
    if (i % 200 === 0 && i > 0) {
      console.log(`⏳ Progress: ${i}/${filteredNodes.length} nodes processed`);
    }
    
    for (let j = i + 1; j < filteredNodes.length; j++) {
      const nodeA = filteredNodes[i];
      const nodeB = filteredNodes[j];
      
      // ✅ QUICK REJECT #1: Skip if nodes are too far apart (in degrees ≈ meters/111000)
      // FIXED: Removed space in variable name
      const dx = nodeA.coord[0] - nodeB.coord[0];
      const dy = nodeA.coord[1] - nodeB.coord[1];
      const approxDistMeters = Math.sqrt(dx*dx + dy*dy) * 111000; // FIXED: was "1 11000"
      
      if (approxDistMeters > maxEdgeMeters) continue; // FIXED: was "approxDist Meters"
      
      // Create the candidate edge line
      const line = lineString([nodeA.coord, nodeB.coord]);
      const lineBbox = bbox(line);
      const lineCenter = [
        (nodeA.coord[0] + nodeB.coord[0]) / 2, 
        (nodeA.coord[1] + nodeB.coord[1]) / 2
      ];
      
      // 🔧 STEP 4: Check against obstacles with SPATIAL FILTERING
      let isSafe = true;
      
      // FIXED: Removed space in "for" keyword
      for (const obstacle of cleanObstacles) {
        // 🚫 Quick reject #1: Bounding boxes don't overlap? Skip expensive check!
        // This eliminates ~80% of obstacles without calling booleanDisjoint
        if (lineBbox[2] < obstacle.bbox[0] - 0.01 || 
            lineBbox[0] > obstacle.bbox[2] + 0.01 ||
            lineBbox[3] < obstacle.bbox[1] - 0.01 || 
            lineBbox[1] > obstacle.bbox[3] + 0.01) {
          continue;
        }
        
        // 🚫 Quick reject #2: Line center far from obstacle centroid? Skip!
        // This catches obstacles that are "nearby in bbox" but actually far away
        const centerDist = Math.sqrt(
          Math.pow(lineCenter[0] - obstacle.centroid[0], 2) + 
          Math.pow(lineCenter[1] - obstacle.centroid[1], 2)
        ) * 111000; // Convert degrees to meters
        
        // Allow some padding: obstacle size + edge length + 100m buffer
        if (centerDist > (obstacle.bboxSize * 111000) + approxDistMeters + 100) {
          continue;
        }
        
        // ✅ Only now do the EXPENSIVE booleanDisjoint check
        // This runs only for obstacles that passed both quick filters
        if (!safeBooleanDisjoint(line, obstacle.geometry)) {
          isSafe = false;
          break; // No need to check remaining obstacles
        }
      }
      
      // If edge passed all obstacle checks, add it to the graph
      if (isSafe) {
        edges.push({
          from: nodeA.id,
          to: nodeB.id,
          weight: approxDistMeters,  // Distance in meters = path cost
          geometry: line.geometry    // Keep for debugging/visualization
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
 * 
 * 🎯 WHAT IT DOES:
 * Finds the shortest path from ANY 'start' node to ANY 'goal' node.
 * 
 * 🧒 SIMPLE EXPLANATION:
 * Imagine you're flooding the graph with water 💧
 * Water starts at all mine corners (distance = 0)
 * Water flows along edges, always taking the shortest path first
 * When water first touches ANY road point → STOP! That's the shortest path!
 * Then trace backwards to see the exact route the water took
 * 
 * 📥 INPUT: 
 *   • nodes: Array of { id, type, coord: [lon, lat] }
 *   • edges: Array of { from, to, weight }
 * 📤 OUTPUT: Array of coordinates representing the optimal path, or null if no path
 * 
 * 🔑 KEY INSIGHT:
 * We don't pre-select a destination road point!
 * Dijkstra automatically finds the NEAREST reachable road point
 * This is why the path connects to the optimal location, not a random one
 */
function runDijkstra(nodes, edges) {
  // 🔍 DEBUG: Log graph statistics
  console.log(`🧭 Dijkstra starting: ${nodes.length} nodes, ${edges.length} edges`);
  console.log(`   Start nodes: ${nodes.filter(n => n.type === 'start').length}`);
  console.log(`   Goal nodes: ${nodes.filter(n => n.type === 'goal').length}`);

  // ✅ Pre-check: Do we have any goal nodes?
  const hasGoals = nodes.some(n => n.type === 'goal');
  if (!hasGoals) {
    console.warn('⚠️ No goal nodes (road samples) in graph - cannot find path');
    return null;
  }
  
  // ✅ Pre-check: Do we have any start nodes?
  const hasStarts = nodes.some(n => n.type === 'start');
  if (!hasStarts) {
    console.warn('⚠️ No start nodes (mine corners) in graph');
    return null;
  }

  // 🔍 Quick sanity check: Are any start nodes directly connected to goal nodes?
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
  
  // 1️⃣ Build Adjacency List: nodeId -> [{ to, weight }]
  const adj = {};
  nodes.forEach(n => adj[n.id] = []);
  edges.forEach(e => {
    adj[e.from].push({ to: e.to, weight: e.weight });
    adj[e.to].push({ to: e.from, weight: e.weight }); // Undirected graph (roads work both ways)
  });

  // 2️⃣ Initialize tracking arrays
  const dist = {};      // Shortest known distance to each node
  const prev = {};      // Previous node in shortest path (for backtracking)
  const visited = new Set();  // Nodes we've already processed
  
  // Set all distances to Infinity initially (unknown)
  nodes.forEach(n => dist[n.id] = Infinity);

  // 3️⃣ Set ALL mine corners as starting points (distance = 0)
  const startNodes = nodes.filter(n => n.type === 'start');
  startNodes.forEach(n => dist[n.id] = 0);

  // 4️⃣ Main Dijkstra Loop: Expand outward from start nodes
  while (true) {
    // Find unvisited node with the smallest known distance
    let currentId = null;
    let minDist = Infinity;

    for (const id in dist) {
      if (!visited.has(id) && dist[id] < minDist) {
        minDist = dist[id];
        currentId = id;
      }
    }

    // If no reachable nodes left, path doesn't exist
    if (currentId === null) return null;

    visited.add(currentId);

    // 🎯 GOAL CHECK: If we hit a road node, we're done!
    const currentNode = nodes.find(n => n.id == currentId);
    if (currentNode?.type === 'goal') {
      return reconstructPath(prev, currentNode, nodes);
    }

    // Explore neighbors: Update distances if we found a shorter path
    const neighbors = adj[currentId] || [];
    neighbors.forEach(neighbor => {
      if (!visited.has(neighbor.to)) {
        const newDist = dist[currentId] + neighbor.weight;
        if (newDist < dist[neighbor.to]) {
          dist[neighbor.to] = newDist;
          prev[neighbor.to] = currentId; // Remember how we got here
        }
      }
    });
  }
}

/**
 * 🔙 reconstructPath(prev, endNode, allNodes)
 * 
 * 🎯 WHAT IT DOES: 
 * Walks backwards from the goal to the start using 'prev' pointers,
 * then reverses to get Start → Goal order.
 * 
 * 📥 INPUT: 
 *   • prev: Object mapping nodeId -> previousNodeId
 *   • endNode: The goal node where Dijkstra stopped
 *   • allNodes: Full node array to look up coordinates
 * 📤 OUTPUT: Array of [lon, lat] coordinates representing the path
 */
function reconstructPath(prev, endNode, allNodes) {
  const path = [endNode.coord];
  let currentId = endNode.id;

  // Walk backwards through the 'prev' chain
  while (prev[currentId] !== undefined) {
    currentId = prev[currentId];
    const node = allNodes.find(n => n.id == currentId);
    if (node?.coord) path.push(node.coord);
  }

  // Reverse to get Start → Goal order
  return path.reverse();
}

export { buildVisibilityEdges, runDijkstra };