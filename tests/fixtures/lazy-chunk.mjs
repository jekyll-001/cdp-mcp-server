export function makeRunner(seed){const closure=seed;return function run(){let local=2;local+=closure;window.__result=local;return local}}
