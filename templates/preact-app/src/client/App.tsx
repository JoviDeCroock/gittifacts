import { createCounter, createServerClock } from "./state.js";

const counter = createCounter();
const clock = createServerClock();

export function App() {
  return (
    <main>
      <h1>Preact + signals on Workers</h1>
      <p>
        <button type="button" onClick={counter.increment}>
          Count: {counter.count}
        </button>
        doubled: {counter.double}
      </p>
      <p>
        <button type="button" onClick={() => void clock.refresh()}>
          Server time
        </button>
        <output>{clock.error.value ?? clock.now.value ?? "not loaded"}</output>
      </p>
    </main>
  );
}
