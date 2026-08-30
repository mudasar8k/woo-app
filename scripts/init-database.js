const { Pool } = require('pg')
const fs = require('fs')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env.local') })

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
})

async function initDatabase() {
  try {
    const sqlFile = fs.readFileSync(path.join(__dirname, 'init-db.sql'), 'utf8')
    
    // Split by semicolon and execute each statement
    const statements = sqlFile.split(';').filter(stmt => stmt.trim().length > 0)
    
    console.log('Initializing database...')
    
    for (const statement of statements) {
      if (statement.trim()) {
        await pool.query(statement)
      }
    }
    
    console.log('Database initialized successfully!')
    
    // Create a default super admin user
    const bcrypt = require('bcryptjs')
    const hashedPassword = await bcrypt.hash('admin123', 10)
    
    await pool.query(
      `INSERT INTO users (email, password_hash, name, role) 
       VALUES ($1, $2, $3, $4) 
       ON CONFLICT (email) DO NOTHING`,
      ['admin@example.com', hashedPassword, 'Super Admin', 'super_admin']
    )
    
    console.log('Default super admin user created:')
    console.log('Email: admin@example.com')
    console.log('Password: admin123')
    console.log('Please change the password after first login!')
    
    process.exit(0)
  } catch (error) {
    console.error('Error initializing database:', error)
    process.exit(1)
  }
}

initDatabase()






