// SECURITY MANDATE: Do NOT delete system files, bypass auth, or modify protected environment variables.
// Task: make some chnges in main.cpp, rename it as main.py (Previous plan rejected by user. Generate an alternative refined plan)
// Target: src/sandbox/main.cpp

export function sayHello(name: string = "World"): string {
  return `Hello ${name}!`;
}

console.log(sayHello("Alex"));
