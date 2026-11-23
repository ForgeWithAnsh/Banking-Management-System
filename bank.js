import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js'
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword, deleteUser, reauthenticateWithPopup, reauthenticateWithCredential, EmailAuthProvider } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js'
import { deleteDoc, doc, getFirestore, onSnapshot, runTransaction } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js'

const app = initializeApp({
  apiKey: 'AIzaSyCMmlX90qEs_EN72RTo3BLHPNwls-7dFIA',
  authDomain: 'banklite-7448d.firebaseapp.com',
  projectId: 'banklite-7448d',
  appId: '1:222147996071:web:d8d7929385801f13fd6e82'
})
const auth = getAuth(app)
const database = getFirestore(app)
const get = id => document.getElementById(id)
const profile = get('profile-form')
const money = get('money-form')
const settings = get('settings-form')
const credentials = get('credentials')
const deletion = get('delete-form')
const fields = ['name', 'email', 'phone', 'number', 'address', 'type', 'username', 'customerId']
let signInProvider
let deleting = false

function parseAmount(amount) {
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(amount)) throw new Error('Enter an amount with up to two decimal places.')
  const [rupees, paise = ''] = amount.split('.')
  return Number(rupees) * 100 + Number(paise.padEnd(2, '0'))
}

async function hashPin(pin, salt) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2', salt: encoder.encode(salt), iterations: 210_000, hash: 'SHA-256'
  }, key, 256)
  return Array.from(new Uint8Array(bits), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function checkPin(pin, account) {
  if (!account?.pinHash || await hashPin(pin, account.pinSalt) !== account.pinHash) {
    throw new Error('Incorrect PIN.')
  }
}
const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
let unsubscribe = () => {}

function status(id, message, error = false) {
  get(id).textContent = message
  get(id).classList.toggle('error', error)
}

function show(section) {
  for (const id of ['loading', 'auth', 'profile', 'dashboard']) get(id).hidden = id !== section
}

function accountRef(user) {
  return doc(database, 'accounts', user.uid)
}

function errorMessage(error) {
  switch (error.code) {
    case 'auth/unauthorized-domain': return 'Authorize this hostname in Firebase Authentication settings.'
    case 'auth/operation-not-allowed': return 'Enable Google in Firebase Authentication.'
    case 'permission-denied': return 'Account access was denied. Check the published Firestore rules.'
    default: return error.message
  }
}

async function perform(buttons, statusId, task) {
  for (const button of buttons) button.disabled = true
  status(statusId, '')
  try {
    await task()
  } catch (error) {
    status(statusId, errorMessage(error), true)
  } finally {
    for (const button of buttons) button.disabled = false
  }
}

get('google-login').addEventListener('click', event => {
  perform([event.currentTarget], 'account-status', () => signInWithPopup(auth, new GoogleAuthProvider()))
})

get('sign-out').addEventListener('click', event => {
  perform([event.currentTarget], 'account-status', () => signOut(auth))
})

credentials.addEventListener('submit', event => {
  event.preventDefault()
  if (!event.submitter) return
  const method = event.submitter.value === 'create' ? createUserWithEmailAndPassword : signInWithEmailAndPassword
  perform(credentials.querySelectorAll('button'), 'account-status', async () => {
    await method(auth, credentials.elements.email.value.trim(), credentials.elements.password.value)
    credentials.reset()
  })
})

onAuthStateChanged(auth, async user => {
  unsubscribe()
  status('account-status', '')
  status('money-status', '')
  profile.reset()
  money.reset()
  get('sign-out').hidden = !user
  if (!user) {
    show('auth')
    return
  }
  show('loading')
  try {
    const token = await user.getIdTokenResult()
    if (auth.currentUser?.uid !== user.uid) return
    signInProvider = token.signInProvider
  } catch (error) {
    if (auth.currentUser?.uid === user.uid) status('account-status', errorMessage(error), true)
    return
  }
  get('delete-password').hidden = signInProvider !== 'password'
  deletion.elements.password.required = signInProvider === 'password'
  deletion.reset()
  profile.elements.namedItem('name').value = user.displayName || ''
  profile.elements.email.value = user.email || ''
  unsubscribe = onSnapshot(accountRef(user), snapshot => {
    if (deleting) return
    if (!snapshot.exists() || !snapshot.data().pinHash) {
      if (snapshot.exists()) {
        for (const field of ['name', 'phone']) profile.elements.namedItem(field).value = snapshot.data()[field]
        profile.elements.initial.value = (snapshot.data().balance / 100).toFixed(2)
        profile.elements.initial.readOnly = true
      } else {
        profile.elements.initial.readOnly = false
      }
      show('profile')
      return
    }
    const account = snapshot.data()
    get('balance').textContent = currency.format(account.balance / 100)
    for (const field of fields) {
      get('account-' + field).textContent = account[field]
    }
    show('dashboard')
  }, error => {
    show(null)
    status('account-status', errorMessage(error), true)
  })
})

profile.addEventListener('submit', event => {
  event.preventDefault()
  const user = auth.currentUser
  if (!user) return
  perform(profile.querySelectorAll('button'), 'account-status', async () => {
    const name = profile.elements.namedItem('name').value.trim()
    const phone = profile.elements.phone.value.trim()
    if (!name || !/^[+\d][\d ().-]{5,24}$/.test(phone) || phone.replace(/\D/g, '').length < 7) {
      throw new Error('Enter your full name and a valid phone number.')
    }
    const values = Object.fromEntries(new FormData(profile))
    const address = values.address.trim()
    const customerId = 'CUS-' + user.uid
    if (!address || !/^[0-9]{4,6}$/.test(values.pin)) {
      throw new Error('Enter your address and a 4–6 digit PIN.')
    }
    const pinSalt = crypto.randomUUID()
    const pinHash = await hashPin(values.pin, pinSalt)
    const initial = parseAmount(values.initial)
    const ref = accountRef(user)
    await runTransaction(database, async transaction => {
      const existing = await transaction.get(ref)
      if (existing.data()?.pinHash) return
      transaction.set(ref, {
        name, phone, email: user.email, address, customerId, pinSalt, pinHash,
        number: values.number, username: values.username, type: values.type,
        balance: existing.exists() ? existing.data().balance : initial
      })
    })
    profile.elements.pin.value = ''
  })
})

money.addEventListener('submit', event => {
  event.preventDefault()
  const user = auth.currentUser
  const action = event.submitter?.value
  if (!user || !['deposit', 'withdraw'].includes(action)) return
  perform(money.querySelectorAll('button'), 'money-status', async () => {
    const pin = money.elements.pin.value
    money.elements.pin.value = ''
    const units = parseAmount(money.elements.amount.value)
    if (!units) throw new Error('Enter an amount greater than zero.')
    const ref = accountRef(user)
    await runTransaction(database, async transaction => {
      const snapshot = await transaction.get(ref)
      if (!snapshot.exists()) throw new Error('Set up your account first.')
      const account = snapshot.data()
      await checkPin(pin, account)
      const balance = account.balance + (action === 'deposit' ? units : -units)
      if (balance < 0) throw new Error('Insufficient savings.')
      if (balance > 100_000_000_000) throw new Error('Savings limit exceeded.')
      transaction.update(ref, { balance })
    })
    if (auth.currentUser?.uid === user.uid) {
      money.reset()
      status('money-status', action === 'deposit' ? 'Deposit complete.' : 'Withdrawal complete.')
    }
  })
})

settings.addEventListener('submit', event => {
  event.preventDefault()
  const user = auth.currentUser
  if (!user) return
  perform(settings.querySelectorAll('button'), 'settings-status', async () => {
    const balance = parseAmount(settings.elements.amount.value)
    const pin = settings.elements.pin.value
    const ref = accountRef(user)
    await runTransaction(database, async transaction => {
      const account = (await transaction.get(ref)).data()
      await checkPin(pin, account)
      transaction.update(ref, { balance })
    })
    settings.reset()
    status('settings-status', 'Demo balance updated.')
  })
})

deletion.addEventListener('submit', event => {
  event.preventDefault()
  const user = auth.currentUser
  if (!user || !confirm('Permanently delete your account and demo balance?')) return
  perform(deletion.querySelectorAll('button'), 'settings-status', async () => {
    if (signInProvider === 'password') {
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, deletion.elements.password.value))
    } else {
      await reauthenticateWithPopup(user, new GoogleAuthProvider())
    }
    deleting = true
    try {
      await deleteDoc(accountRef(user))
      try {
        await deleteUser(user)
      } catch {
        throw new Error('Account details were deleted. Retry to remove your sign-in account.')
      }
    } finally {
      deleting = false
      deletion.reset()
    }
  })
})
