import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const MAX_TOKENS: number = Number(core.getInput("max_tokens"));

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  return response.data as string;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails,
  customPrompts: string
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails, customPrompts);
      const aiResponse = await getAIResponse(prompt);

      console.log(`Prompt: ${prompt}`);
      console.log(`Response: ${JSON.stringify(aiResponse)}`);
      console.log("---------");

      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails, customPrompts: string): string {
  const diffContent = chunk.changes.map(change => `${change.ln || change.ln2} ${change.content}`).join('\n');
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.
${customPrompts}

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${diffContent}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: MAX_TOKENS,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const res = response.choices[0].message?.content?.trim() || "{}";

    return JSON.parse(res).reviews;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

function escapeJSONString(str: string): string {
  return str.replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\u0000/g, '\\u0000')
            .replace(/\u0001/g, '\\u0001')
            .replace(/\u0002/g, '\\u0002')
            .replace(/\u0003/g, '\\u0003')
            .replace(/\u0004/g, '\\u0004')
            .replace(/\u0005/g, '\\u0005')
            .replace(/\u0006/g, '\\u0006')
            .replace(/\u0007/g, '\\u0007')
            .replace(/\u0008/g, '\\b')
            .replace(/\u0009/g, '\\t')
            .replace(/\u000A/g, '\\n')
            .replace(/\u000B/g, '\\v')
            .replace(/\u000C/g, '\\f')
            .replace(/\u000D/g, '\\r')
            .replace(/\u000E/g, '\\u000E')
            .replace(/\u000F/g, '\\u000F')
            .replace(/\u0010/g, '\\u0010')
            .replace(/\u0011/g, '\\u0011')
            .replace(/\u0012/g, '\\u0012')
            .replace(/\u0013/g, '\\u0013')
            .replace(/\u0014/g, '\\u0014')
            .replace(/\u0015/g, '\\u0015')
            .replace(/\u0016/g, '\\u0016')
            .replace(/\u0017/g, '\\u0017')
            .replace(/\u0018/g, '\\u0018')
            .replace(/\u0019/g, '\\u0019')
            .replace(/\u001A/g, '\\u001A')
            .replace(/\u001B/g, '\\u001B')
            .replace(/\u001C/g, '\\u001C')
            .replace(/\u001D/g, '\\u001D')
            .replace(/\u001E/g, '\\u001E')
            .replace(/\u001F/g, '\\u001F')
            .replace(/'/g, "\\'");
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    const lineNumber = Number(aiResponse.lineNumber);
    const line = chunk.changes.find(change => (change.ln || change.ln2) === lineNumber);
    if (!line) {
      console.log(`Line number ${lineNumber} not found in chunk for file ${file.to}`);
      return [];
    }
    return {
      body: escapeJSONString(aiResponse.reviewComment),
      path: file.to,
      line: lineNumber,
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  try {
    const body = JSON.stringify({
      event: "COMMENT",
      comments: comments.map(comment => ({
        body: comment.body,
        path: comment.path,
        line: comment.line,
      })),
    });

    console.log("Request body:", body);
    console.log("Request body length:", body.length);

    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      event: "COMMENT",
      comments: comments.map(comment => ({
        body: comment.body,
        path: comment.path,
        line: comment.line,
      })),
    });
    console.log("Review comments created successfully.");
  } catch (error) {
    console.error("Error creating review comments:", error);
  }
}

async function main() {
  console.log("Fetching PR details...");
  const prDetails = await getPRDetails();
  console.log("PR Details fetched:", prDetails);

  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  console.log("Event data:", eventData);

  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  console.log("Raw diff:", diff);

  const parsedDiff = parseDiff(diff);
  console.log("Parsed diff files:", parsedDiff.map(file => file.to));

  const includePatterns = core
    .getInput("include")
    .split(",")
    .map((s) => s.trim());

  console.log("Include patterns:", includePatterns);

  const filteredDiff = parsedDiff.filter((file) => {
    return includePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  console.log("Filtered diff files:", filteredDiff.map(file => file.to));

  const customPrompts = core.getMultilineInput("custom_prompts")
      .map(customPrompt => `- ${customPrompt}`)
      .join("\n");

  console.log("Custom prompts:", customPrompts);

  const comments = await analyzeCode(filteredDiff, prDetails, customPrompts);
  console.log("Comments generated:", comments);

  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  } else {
    console.log("No comments to create.");
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
