import { useState } from "react";
import { streamText, smoothStream, type APICallError } from "ai";
import { parsePartialJson } from "@ai-sdk/ui-utils";
import { useTranslation } from "react-i18next";
import Plimit from "p-limit";
import {
  getSystemPrompt,
  generateQuestionsPrompt,
  generateSerpQueriesPrompt,
  processSearchResultPrompt,
  reviewSerpQueriesPrompt,
  writeFinalReportPrompt,
  getSERPQuerySchema,
} from "@/utils/deep-research";
import { useGoogleProvider } from "@/hooks/useAiProvider";
import { useTaskStore } from "@/store/task";
import { useSettingStore } from "@/store/setting";
import { toast } from "sonner";
import { pick, flat, isString, isObject } from "radash";
import { useGlobalStore } from "@/store/global";
import i18next from 'i18next';

function getResponseLanguagePrompt(lang: string) {
  return `\n\n**Respond in ${lang}**\n\n`;
}

function removeJsonMarkdown(text: string) {
  text = text.trim();
  if (text.startsWith("```json")) {
    text = text.slice(7);
  } else if (text.startsWith("json")) {
    text = text.slice(4);
  } else if (text.startsWith("```")) {
    text = text.slice(3);
  }
  if (text.endsWith("```")) {
    text = text.slice(0, -3);
  }
  return text.trim();
}

function handleError(err: unknown) {
  const t = i18next.t.bind(i18next);
  console.error(err);
  if (isString(err)) toast.error(err);
  if (isObject(err)) {
    const { error } = err as { error: APICallError };
    if (error.responseBody) {
      const response = JSON.parse(error.responseBody) as GeminiError;
      if (response.error.status === "FORBIDDEN") {
        const { setOpenSetting } = useGlobalStore.getState();
        setOpenSetting(true);
        toast.error(t("tips.authFailed"));
      }
      else {
        toast.error(`[${response.error.status}]: ${response.error.message}`);
      }
    } else {
      toast.error(`[${error.name}]: ${error.message}`);
    }
  }
}

function useDeepResearch() {
  const { t } = useTranslation();
  const taskStore = useTaskStore();
  const google = useGoogleProvider();
  const [status, setStatus] = useState<string>("");

  async function askQuestions() {
    const { language } = useSettingStore.getState();
    const { question } = useTaskStore.getState();
    setStatus(t("research.common.thinking"));
    const result = streamText({
      model: google("gemini-2.0-flash-thinking-exp"),
      system: getSystemPrompt(),
      prompt:
        generateQuestionsPrompt(question) + getResponseLanguagePrompt(language),
      experimental_transform: smoothStream(),
      onError: handleError,
    });
    let content = "";
    taskStore.setQuestion(question);
    for await (const textPart of result.textStream) {
      content += textPart;
      taskStore.updateQuestions(content);
    }
  }

  async function runSearchTask(queries: SearchTask[]) {
    const { language } = useSettingStore.getState();
    setStatus(t("research.common.research"));
    const plimit = Plimit(1);
    for await (const item of queries) {
      await plimit(async () => {
        let content = "";
        const sources: Source[] = [];
        taskStore.updateTask(item.query, { state: "processing" });
        const searchResult = streamText({
          model: google("gemini-2.0-flash-exp", { useSearchGrounding: true }),
          system: getSystemPrompt(),
          prompt:
            processSearchResultPrompt(item.query, item.researchGoal) +
            getResponseLanguagePrompt(language),
          experimental_transform: smoothStream(),
          onError: handleError,
        });
        for await (const part of searchResult.fullStream) {
          if (part.type === "text-delta") {
            content += part.textDelta;
            taskStore.updateTask(item.query, { learning: content });
          } else if (part.type === "reasoning") {
            console.log("reasoning", part.textDelta);
          } else if (part.type === "source") {
            sources.push(part.source);
          }
        }
        taskStore.updateTask(item.query, { state: "completed", sources });
        return content;
      });
    }
  }

  async function reviewSearchResult() {
    const { language } = useSettingStore.getState();
    const { query, tasks, suggestion } = useTaskStore.getState();
    setStatus(t("research.common.research"));
    const learnings = tasks.map((item) => item.learning);
    const result = streamText({
      model: google("gemini-2.0-flash-thinking-exp"),
      system: getSystemPrompt(),
      prompt:
        reviewSerpQueriesPrompt(query, learnings, suggestion) +
        getResponseLanguagePrompt(language),
      experimental_transform: smoothStream(),
      onError: handleError,
    });

    const querySchema = getSERPQuerySchema();
    let content = "";
    let queries = [];
    for await (const textPart of result.textStream) {
      content += textPart;
      const data: PartialJson = parsePartialJson(removeJsonMarkdown(content));
      if (
        querySchema.safeParse(data.value) &&
        data.state === "successful-parse"
      ) {
        if (data.value) {
          queries = data.value.map(
            (item: { query: string; researchGoal: string }) => ({
              state: "unprocessed",
              learning: "",
              ...pick(item, ["query", "researchGoal"]),
            })
          );
        }
      }
    }
    if (queries.length > 0) {
      taskStore.update([...tasks, ...queries]);
      await runSearchTask(queries);
    }
  }

  async function writeFinalReport() {
    const { language } = useSettingStore.getState();
    const { query, tasks, setTitle } = useTaskStore.getState();
    setStatus(t("research.common.writing"));
    const learnings = tasks.map((item) => item.learning);
    const result = streamText({
      model: google("gemini-2.0-flash-thinking-exp"),
      system: getSystemPrompt(),
      prompt:
        writeFinalReportPrompt(query, learnings) +
        getResponseLanguagePrompt(language),
      experimental_transform: smoothStream(),
      onError: handleError,
    });
    let content = "";
    for await (const textPart of result.textStream) {
      content += textPart;
      taskStore.updateFinalReport(content);
    }
    const title = content.split("\n\n")[0].replaceAll("#", "").trim();
    setTitle(title);
    const sources = flat(
      tasks.map((item) => (item.sources ? item.sources : []))
    );
    if (sources.length > 0) {
      content += `\n\n---\n\n## ${t("research.finalReport.researchedInfor", {
        total: sources.length,
      })}\n\n${sources
        .map(
          (source, idx) =>
            `${idx + 1}. [${source.title || source.url}](${source.url})`
        )
        .join("\n")}`;
    }
    taskStore.updateFinalReport(content);
    return content;
  }

  async function deepResearch() {
    const { language } = useSettingStore.getState();
    const { query } = useTaskStore.getState();
    setStatus(t("research.common.thinking"));
    try {
      let queries = [];

      const result = streamText({
        model: google("gemini-2.0-flash-thinking-exp"),
        system: getSystemPrompt(),
        prompt:
          generateSerpQueriesPrompt(query) +
          getResponseLanguagePrompt(language),
        experimental_transform: smoothStream(),
        onError: handleError,
      });

      const querySchema = getSERPQuerySchema();
      let content = "";
      for await (const textPart of result.textStream) {
        content += textPart;
        const data: PartialJson = parsePartialJson(removeJsonMarkdown(content));
        if (querySchema.safeParse(data.value)) {
          if (
            data.state === "repaired-parse" ||
            data.state === "successful-parse"
          ) {
            if (data.value) {
              queries = data.value.map(
                (item: { query: string; researchGoal: string }) => ({
                  state: "unprocessed",
                  learning: "",
                  ...pick(item, ["query", "researchGoal"]),
                })
              );
              taskStore.update(queries);
            }
          }
        }
      }
      await runSearchTask(queries);
    } catch (err) {
      console.error(err);
    }
  }

  return {
    status,
    deepResearch,
    askQuestions,
    runSearchTask,
    reviewSearchResult,
    writeFinalReport,
  };
}

export default useDeepResearch;
