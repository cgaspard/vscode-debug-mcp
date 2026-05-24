// Sample target program for testing the Debug MCP extension.
// Set breakpoints on the lines below via MCP and step through to inspect state.

function fib(n) {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}

function greet(name) {
  const greeting = `hello, ${name}`;
  return greeting;
}

function main() {
  const names = ['alice', 'bob', 'carol'];
  for (const name of names) {
    const message = greet(name);
    console.log(message);
  }

  for (let i = 0; i < 8; i++) {
    const value = fib(i);
    console.log(`fib(${i}) = ${value}`);
  }

  // Keep the process around a bit so debug-console reads catch the output.
  setTimeout(() => {
    console.log('done');
  }, 250);
}

main();
