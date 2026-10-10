'use client';

import { useEffect, useState } from 'react';

/** The value after it has stopped changing for `ms` (search-as-you-type without a request per key). */
export function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
