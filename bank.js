import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js'
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js'
import { doc, getFirestore, onSnapshot, runTransaction } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js'

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

onAuthStateChanged(auth, user => {
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
  profile.elements.namedItem('name').value = user.displayName || ''
  profile.elements.email.value = user.email || ''
  unsubscribe = onSnapshot(accountRef(user), snapshot => {
    if (!snapshot.exists()) {
      show('profile')
      return
    }
    const account = snapshot.data()
    get('balance').textContent = currency.format(account.balance / 100)
    for (const field of ['name', 'email', 'phone']) {
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
    const ref = accountRef(user)
    await runTransaction(database, async transaction => {
      const existing = await transaction.get(ref)
      if (!existing.exists()) transaction.set(ref, { name, phone, email: user.email, balance: 0 })
    })
  })
})

money.addEventListener('submit', event => {
  event.preventDefault()
  const user = auth.currentUser
  const action = event.submitter?.value
  if (!user || !['deposit', 'withdraw'].includes(action)) return
  perform(money.querySelectorAll('button'), 'money-status', async () => {
    const amount = money.elements.amount.value
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(amount)) throw new Error('Enter up to two decimal places.')
    const [rupees, paise = ''] = amount.split('.')
    const units = Number(rupees) * 100 + Number(paise.padEnd(2, '0'))
    if (!units) throw new Error('Enter an amount greater than zero.')
    const ref = accountRef(user)
    await runTransaction(database, async transaction => {
      const snapshot = await transaction.get(ref)
      if (!snapshot.exists()) throw new Error('Set up your account first.')
      const balance = snapshot.data().balance + (action === 'deposit' ? units : -units)
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
