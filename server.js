const http = require('node:http')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { randomUUID, randomBytes, scryptSync, timingSafeEqual } = require('node:crypto')

const db = new DatabaseSync(process.env.BS_DATABASE || join(__dirname, 'bank.sqlite'))
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
    phone TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0
  );
`)
const sessions = new Map()
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/bank.css', ['bank.css', 'text/css']],
  ['/bank.js', ['bank.js', 'text/javascript']]
].map(([path, [file, type]]) => [path, { content: readFileSync(join(__dirname, file)), type }]))
const maxBalance = 100_000_000_000

function findAccount(email) {
  return db.prepare('SELECT * FROM accounts WHERE email = ?').get(email)
}

// Later, Firebase ID token verification can replace this session lookup.
function signedInAccount(req) {
  const token = (req.headers.cookie || '').match(/(?:^|; *)bs_session=([a-f0-9]+)(?:;|$)/)?.[1]
  const session = sessions.get(token)
  if (!session || session.expires <= Date.now()) {
    sessions.delete(token)
    return {}
  }
  const account = db.prepare('SELECT id, name, email, phone, balance FROM accounts WHERE id = ?').get(session.id)
  return { token, account }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  if (req.headers['content-type'] !== 'application/json') throw new Error('Expected JSON')
  let data = ''
  for await (const chunk of req) {
    data += chunk
    if (data.length > 4096) throw new Error('Body too large')
  }
  const body = JSON.parse(data)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body')
  return body
}

http.createServer(async (req, res) => {
  const path = req.url.split('?')[0]
  const asset = assets.get(path)
  if (req.method === 'GET' && asset) {
    res.writeHead(200, { 'Content-Type': asset.type + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff' })
    return res.end(asset.content)
  }
  const { token, account } = signedInAccount(req)
  if (req.method === 'GET' && path === '/api/account') {
    return json(res, 200, { account: account || null })
  }
  if (req.method !== 'POST' || !['/api/register', '/api/login', '/api/logout', '/api/transfer'].includes(path)) {
    return json(res, 404, { error: 'Page not found.' })
  }
  let body
  try {
    body = await readBody(req)
  } catch {
    return json(res, 400, { error: 'Invalid request.' })
  }
  try {
    if (path === '/api/logout') {
      sessions.delete(token)
      res.setHeader('Set-Cookie', 'bs_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
      return json(res, 200, {})
    }
    if (path === '/api/transfer') {
      if (!account) return json(res, 401, { error: 'Please sign in.' })
      const { action, amount } = body
      if (!['deposit', 'withdraw'].includes(action) || typeof amount !== 'string' ||
          !/^\d{1,9}(\.\d{1,2})?$/.test(amount)) {
        return json(res, 400, { error: 'Enter an amount with up to two decimal places.' })
      }
      const [rupees, paise = ''] = amount.split('.')
      const cents = Number(rupees) * 100 + Number(paise.padEnd(2, '0'))
      if (!cents) return json(res, 400, { error: 'Enter an amount greater than zero.' })
      const change = action === 'deposit' ? cents : -cents
      const updated = db.prepare(`
        UPDATE accounts SET balance = balance + ?
        WHERE id = ? AND balance + ? BETWEEN 0 AND ?
        RETURNING id, name, email, phone, balance
      `).get(change, account.id, change, maxBalance)
      if (!updated) {
        return json(res, 400, { error: action === 'withdraw' ? 'Insufficient savings.' : 'Savings limit exceeded.' })
      }
      return json(res, 200, { account: updated })
    }

    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        password.length < 8 || password.length > 128) {
      return json(res, 400, { error: 'Enter a valid email and a password of 8–128 characters.' })
    }
    const existing = findAccount(email)
    let id
    if (path === '/api/register') {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
      if (!name || name.length > 100 || !/^[+\d][\d ().-]{5,24}$/.test(phone) ||
          phone.replace(/\D/g, '').length < 7) {
        return json(res, 400, { error: 'Enter your full name and a valid phone number.' })
      }
      if (existing) return json(res, 409, { error: 'An account already uses that email.' })
      id = randomUUID()
      const salt = randomBytes(16).toString('hex')
      const hash = scryptSync(password, salt, 64).toString('hex')
      db.prepare('INSERT INTO accounts (id, name, email, phone, salt, hash) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, name, email, phone, salt, hash)
    } else {
      const candidate = scryptSync(password, existing?.salt || 'unused-account-salt', 64)
      if (!existing || !timingSafeEqual(candidate, Buffer.from(existing.hash, 'hex'))) {
        return json(res, 401, { error: 'Email or password is incorrect.' })
      }
      id = existing.id
    }
    const now = Date.now()
    for (const [key, session] of sessions) {
      if (session.expires <= now) sessions.delete(key)
    }
    sessions.delete(token)
    const newToken = randomBytes(32).toString('hex')
    sessions.set(newToken, { id, expires: now + 28_800_000 })
    res.setHeader('Set-Cookie', `bs_session=${newToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`)
    return json(res, 200, {})
  } catch (error) {
    console.error(error)
    return json(res, 500, { error: 'Something went wrong. Try again.' })
  }
}).listen(Number(process.env.BS_PORT || 8770), process.env.BS_LAN === '1' ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`Savings app running at http://localhost:${process.env.BS_PORT || 8770}`)
})
