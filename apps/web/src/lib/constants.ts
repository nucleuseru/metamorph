export const ERROR_CODE = {
  UNKNOWN: "An error has occurred",
  NOT_FOUND: "The requested resource was not found.",
  FORBIDDEN: "You do not have permission to perform this action.",
  CONFLICT: "The resource already exists and cannot be modified.",
  TIMEOUT: "The request timed out, wait a while before you try again.",
  BAD_REQUEST: "Invalid request. Please check your input and try again.",
  UNAUTHORIZED: "You are not authenticated. Please log in and try again.",
  TOO_MANY_REQUESTS: "Too many requests. Please wait a moment and try again.",
  INTERNAL_SERVER_ERROR:
    "There was an error at out end. Please try again later.",
  SERVICE_UNAVAILABLE:
    "This service is currently unavailable. Please try again later.",
  REQUEST_ABORTED:
    "The request was aborted. Please try again or check your network connection.",
  NETWORK:
    "A network error occurred. Please check your internet connection and try again.",
};
