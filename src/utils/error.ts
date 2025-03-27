import { type APICallError } from "ai";
import { isString, isObject } from "radash";
import { useGlobalStore } from "@/store/global";
import i18next from 'i18next';

interface GeminiError {
  error: {
    code: number;
    message: string;
    status: string;
  };
}

export function parseError(err: unknown): string {
  const t = i18next.t.bind(i18next);
  let errorMessage: string = "Unknown Error";
  if (isString(err)) errorMessage = err;
  if (isObject(err)) {
    const { error } = err as { error: APICallError };
    if (error.responseBody) {
      const response = JSON.parse(error.responseBody) as GeminiError;
      errorMessage = `[${response.error.status}]: ${response.error.message}`;
      if (response.error.status === "FORBIDDEN") {
        const { setOpenSetting } = useGlobalStore.getState();
        setOpenSetting(true);
        errorMessage = t("tips.authFailed");
      }
      else {
        errorMessage = `[${response.error.status}]: ${response.error.message}`;
      }
    } else {
      errorMessage = `[${error.name}]: ${error.message}`;
    }
  }
  return errorMessage;
}
