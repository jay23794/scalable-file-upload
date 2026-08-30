// Mirrors backend/src/utils/apiResponse.ts so both services speak the same
// envelope. ml's HTTP surface is small — debug endpoints and one retained
// /embed escape hatch, since the real work arrives over BullMQ — but there is
// no reason for it to differ from the backend's shape.

export interface ApiResponse<T> {
  success: boolean;
  message?: string;
  data?: T;
  errors?: unknown;
}

export const successResponse = <T>(data: T, message = 'Success'): ApiResponse<T> => ({
  success: true,
  message,
  data,
});
