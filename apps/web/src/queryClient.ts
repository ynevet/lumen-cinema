import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api/client';

/**
 * One client for the app.
 *
 * The defaults we rely on and deliberately do not change:
 *   - `refetchOnWindowFocus` is on, so returning to the tab shows current seats at once.
 *   - `refetchInterval` polling pauses while the tab is in the background, which is exactly
 *     what we want: nobody needs live seats in a tab they are not looking at.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 4xx will not fix itself on a retry - only network or server trouble might.
      retry: (failureCount, error) =>
        failureCount < 2 && !(error instanceof ApiError && error.status < 500),
      // Seat availability is worthless the moment it is stale.
      staleTime: 0,
    },
    // Holding a seat is not idempotent from the user's point of view; never auto-retry.
    mutations: { retry: false },
  },
});
