const get = id => document.getElementById(id)
const auth = get('auth-form')
const money = get('money-form')
const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
let registering = false

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }
  const response = await fetch('/api/' + path, options)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error)
  return data
}

function status(id, message, error = false) {
  get(id).textContent = message
  get(id).classList.toggle('error', error)
}

function render(account) {
  get('loading').hidden = true
  get('auth').hidden = Boolean(account)
  get('dashboard').hidden = !account
  get('sign-out').hidden = !account
  get('balance').textContent = account ? currency.format(account.balance / 100) : ''
  for (const field of ['name', 'email', 'phone']) {
    get('account-' + field).textContent = account?.[field] || ''
  }
}

get('switch-mode').addEventListener('click', () => {
  registering = !registering
  get('registration').hidden = !registering
  for (const field of ['name', 'phone']) auth.elements.namedItem(field).disabled = !registering
  auth.elements.password.autocomplete = registering ? 'new-password' : 'current-password'
  const title = registering ? 'Create account' : 'Sign in'
  get('auth-title').textContent = title
  get('auth-submit').textContent = title
  get('switch-mode').textContent = registering ? 'Sign in' : 'Create account'
  status('auth-status', '')
})

async function perform(buttons, statusId, task) {
  for (const button of buttons) button.disabled = true
  status(statusId, '')
  try {
    await task()
  } catch (error) {
    status(statusId, error.message, true)
  } finally {
    for (const button of buttons) button.disabled = false
  }
}

auth.addEventListener('submit', event => {
  event.preventDefault()
  perform(auth.querySelectorAll('button'), 'auth-status', async () => {
    await api(registering ? 'register' : 'login', Object.fromEntries(new FormData(auth)))
    auth.reset()
    if (registering) get('switch-mode').click()
    render((await api('account')).account)
  })
})

money.addEventListener('submit', event => {
  event.preventDefault()
  const action = event.submitter?.value
  if (!action) return
  perform(money.querySelectorAll('button'), 'money-status', async () => {
    const { account } = await api('transfer', { action, amount: money.elements.amount.value })
    render(account)
    money.reset()
    status('money-status', action === 'deposit' ? 'Deposit complete.' : 'Withdrawal complete.')
  })
})

get('sign-out').addEventListener('click', () => {
  perform([get('sign-out')], 'money-status', async () => {
    await api('logout', {})
    money.reset()
    render(null)
  })
})

api('account').then(({ account }) => render(account)).catch(() => {
  get('loading').textContent = 'Could not reach the savings server. Reload to try again.'
})
