import { useEffect, useRef } from "react";

export function usePollEffect(callback: () => unknown, delay: number | null) {
  const savedCallback = useRef(callback);
  const tick = () => savedCallback.current();

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (delay === null) return;
    tick();
    const id = setInterval(tick, delay);
    return () => {
      clearInterval(id);
    };
  }, [delay]);
}
