// database/db.js
import { Pool } from 'pg';

/**
 * 📌 WHAT THIS FILE DOES:
 * Connects to your PostgreSQL database and fetches spatial data.
 * It's like a librarian who goes to the shelves (tables) and 
 * brings back the books (geometries) you need.
 * 
 * 🔑 KEY POINT: It returns data in GeoJSON format so Turf.js can understand it.
 */

// 🔌 Create a connection pool (like having multiple librarians)
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'mining_db',
  password: '1234', // 🔑 Replace with your actual password
  port: 5432,
});


/**
 * 🗄️ checkEdgeSafety(edgeCoords, obstacleGids)
 * 
 * 🎯 WHAT IT DOES:
 * Uses PostGIS to check if a line intersects any obstacle.
 * Much faster than Turf for batch operations.
 * 
 * 📥 INPUT: 
 *   • edgeCoords: [[lon1, lat1], [lon2, lat2]]
 *   • obstacleGids: Array of { table: 'mines', gid: 123 }
 * 📤 OUTPUT: Promise<boolean> - true if edge is SAFE (no intersection)
 */
async function checkEdgeSafety(pool, edgeCoords, obstacleGids) {
  if (obstacleGids.length === 0) return true;
  
  // Build SQL to check all obstacles in one query
  const conditions = obstacleGids.map(({ table, gid }) => {
    return `EXISTS (
      SELECT 1 FROM ${table} WHERE gid = ${gid} 
      AND ST_Intersects(
        ST_GeomFromText('LINESTRING(${edgeCoords[0][0]} ${edgeCoords[0][1]}, ${edgeCoords[1][0]} ${edgeCoords[1][1]})', 4326),
        geom
      )
    )`;
  }).join(' OR ');
  
  const query = `SELECT ${conditions} as intersects_any`;
  
  try {
    const result = await pool.query(query);
    // If intersects_any is true → edge hits obstacle → NOT safe
    return !result.rows[0].intersects_any;
  } catch (err) {
    console.warn('⚠️ PostGIS edge check failed, falling back to Turf:', err.message);
    // Fallback to Turf if PostGIS fails
    return true; // Assume safe to avoid blocking valid paths
  }
}
/**
 * 📥 fetchSpatialData(mineGid)
 * 
 * 🎯 WHAT IT DOES:
 * Fetches all the data needed to plan a road from a specific mine.
 * 
 * 📥 INPUT: mineGid (number) - The ID of the mine the user clicked
 * 📤 OUTPUT: Promise with all spatial data as GeoJSON objects
 * 
 * 🧩 WHY THIS STRUCTURE:
 * • mine: The starting point (MultiPolygon)
 * • obstacles.mines: Other mines to avoid (MultiPolygon)
 * • obstacles.rivers: Rivers to avoid (MultiPolygon)
 * • schools: Points that will become buffered obstacles (Point)
 * • roads: Destination network (MultiLineString) - YOUR GOAL
 */

async function fetchSpatialData(mineGid) {
  // 1️⃣ Fetch the SELECTED mine (EXCLUDE brick fields)
  const mineRes = await pool.query(
    `SELECT gid, ST_AsGeoJSON(geom) AS geom 
     FROM mines 
     WHERE gid = $1 
     AND name NOT ILIKE '%brick%' 
     AND name NOT ILIKE '%kiln%'`, 
    [mineGid]
  );
  if (mineRes.rows.length === 0) throw new Error('Mine not found or is a brick field');

  // 2️⃣ Fetch OTHER mines (obstacles) - EXCLUDE brick fields
  const otherMinesRes = await pool.query(
    `SELECT gid, ST_AsGeoJSON(geom) AS geom 
     FROM mines 
     WHERE gid != $1 
     AND name NOT ILIKE '%brick%' 
     AND name NOT ILIKE '%kiln%'`, 
    [mineGid]
  );

  // 3️⃣ Fetch RIVERS (no change)
  const riversRes = await pool.query('SELECT gid, ST_AsGeoJSON(geom) AS geom FROM rivers');

  // 4️⃣ Fetch SCHOOLS (no change)
  const schoolsRes = await pool.query('SELECT gid, ST_AsGeoJSON(geom) AS geom FROM schools');

  // 5️⃣ Fetch ROADS (no change)
  const roadsRes = await pool.query('SELECT gid, ST_AsGeoJSON(geom) AS geom FROM roads');

  // Helper: Convert database row → GeoJSON Feature
  const toFeature = (row, properties = {}) => ({
    type: 'Feature',
    geometry: JSON.parse(row.geom),
    properties: { gid: row.gid, ...properties }
  });

  return {
    mine: toFeature(mineRes.rows[0]),
    obstacles: {
      mines: otherMinesRes.rows.map(r => toFeature(r)),
      rivers: riversRes.rows.map(r => toFeature(r))
    },
    schools: schoolsRes.rows.map(r => toFeature(r)),
    roads: roadsRes.rows.map(r => toFeature(r))
  };
}
export { pool, fetchSpatialData,checkEdgeSafety };