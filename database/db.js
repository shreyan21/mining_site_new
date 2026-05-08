// database/db.js
import { Pool } from 'pg';

/**
 * 📌 WHAT THIS FILE DOES:
 * Connects to PostgreSQL and fetches raw spatial data.
 * ⚠️ IMPORTANT: It does NOT process or buffer anything.
 * It simply converts PostGIS geometries to GeoJSON format 
 * so Turf.js can read them later.
 */

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'mining_db',
  password: '1234', // 🔑 Replace with your actual password
  port: 5432,
});

/**
 * 📥 fetchSpatialData(mineGid)
 * 
 * WHAT IT DOES:
 * Pulls all necessary layers from your PostGIS database.
 * 
 * 🔍 NOTICE ABOUT SCHOOLS:
 * Schools are returned as RAW POINTS. Why?
 * Because the buffer distance (300m, 500m, 1km) is provided by the USER
 * at runtime. We can't buffer in the database without rebuilding tables
 * on every request. Buffering happens later in server.js.
 * 
 * 📥 INPUT: mineGid (Integer)
 * 📤 OUTPUT: Promise<Object> with all layers as GeoJSON
 */
async function fetchSpatialData(mineGid) {
  // 1️⃣ Fetch the SELECTED mine
  const mineRes = await pool.query(
    'SELECT gid, ST_AsGeoJSON(geom) AS geom FROM mines WHERE gid = $1', 
    [mineGid]
  );
  if (mineRes.rows.length === 0) throw new Error('Mine not found');

  // 2️⃣ Fetch OTHER mines
  const otherMinesRes = await pool.query(
    'SELECT gid, ST_AsGeoJSON(geom) AS geom FROM mines WHERE gid != $1', 
    [mineGid]
  );

  // 3️⃣ Fetch RIVERS
  const riversRes = await pool.query('SELECT gid, ST_AsGeoJSON(geom) AS geom FROM rivers');

  // 4️⃣ Fetch SCHOOLS
  const schoolsRes = await pool.query('SELECT gid, ST_AsGeoJSON(geom) AS geom FROM schools');

  // 5️⃣ Fetch ROADS
  const roadsRes = await pool.query('SELECT gid, ST_AsGeoJSON(geom) AS geom FROM roads');

  // 🔧 HELPER: Convert {gid, geom} → GeoJSON Feature
  const toFeature = (row, properties = {}) => ({
    type: 'Feature',
    geometry: JSON.parse(row.geom),
    properties: { gid: row.gid, ...properties }
  });

  return {
    // ✅ Mine as Feature
    mine: toFeature(mineRes.rows[0]),
    
    // ✅ Obstacles as array of Features
    obstacles: {
      mines: otherMinesRes.rows.map(r => toFeature(r)),
      rivers: riversRes.rows.map(r => toFeature(r))
    },
    
    // ✅ Schools as Features (with gid in properties)
    schools: schoolsRes.rows.map(r => toFeature(r)),
    
    // ✅ Roads as Features
    roads: roadsRes.rows.map(r => toFeature(r))
  };
}

export  { pool, fetchSpatialData };