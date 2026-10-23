document.querySelector('#load').addEventListener('click', () => {
  void import('./lazy-chunk.mjs').then(({ makeRunner }) => makeRunner(40)());
});
console.log('tab-one-ready');
