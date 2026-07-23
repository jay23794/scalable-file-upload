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
