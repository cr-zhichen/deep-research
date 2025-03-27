import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface SettingStore {
  apiKey: string;
  apiProxy: string;
  accessPassword: string;
  thinkingModel: string;
  networkingModel: string;
  language: string;
}

interface SettingFunction {
  update: (values: Partial<SettingStore>) => void;
}

export const defaultValues = {
  apiKey: "",
  apiProxy: "",
  accessPassword: "",
  thinkingModel: "gemini-2.5-pro-exp-03-25",
  networkingModel: "gemini-2.0-flash-exp",
  language: "",
};

export const useSettingStore = create(
  persist<SettingStore & SettingFunction>(
    (set) => ({
      ...defaultValues,
      update: (values) => set(values),
    }),
    { name: "setting" }
  )
);
