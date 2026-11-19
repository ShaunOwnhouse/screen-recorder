// Shows N, N-1 … 1, one per second. The main process runs the same clock and starts recording at 0.
const el = document.getElementById('n')!
let n = Math.max(1, Number(new URLSearchParams(location.search).get('s')) || 3)

function show(): void {
  el.textContent = String(n)
  el.classList.remove('tick')
  void el.offsetWidth
  el.classList.add('tick')
}

show()
const timer = setInterval(() => {
  n -= 1
  if (n <= 0) clearInterval(timer)
  else show()
}, 1000)
