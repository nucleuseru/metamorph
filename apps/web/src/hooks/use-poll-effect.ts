import { useEffect, useRef } from "react";

export function usePollEffect(callback: () => void, delay: number | null) {
  const savedCallback = useRef(callback);
  const tick = () => savedCallback.current();

  useEffect(() => {
    if (delay !== null) tick();
  }, []);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (delay === null) return;
    const id = setInterval(tick, delay);
    return () => clearInterval(id);
  }, [delay]);
}
