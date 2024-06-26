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
      body: aiResponse.reviewComment,
      path: file.to,
      line: lineNumber,
    };
  });
}

async function createReviewCommentBatch(
  owner: string,
  repo: string,
  pull_number: number,
  commentsBatch: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  try {
    const body = JSON.stringify({
      event: "COMMENT",
      comments: commentsBatch.map(comment => ({
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
      comments: commentsBatch.map(comment => ({
        body: comment.body,
        path: comment.path,
        line: comment.line,
      })),
    });
    console.log("Review comments batch created successfully.");
  } catch (error) {
    console.error("Error creating review comments:", error);
  }
}

async function createReviewComments(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  const batchSize = 5;
  console.log(`Total comments: ${comments.length}`);
  for (let i = 0; i < comments.length; i += batchSize) {
    const batch = comments.slice(i, i + batchSize);
    console.log(`Sending batch ${Math.floor(i / batchSize) + 1}:`, batch);
    await createReviewCommentBatch(owner, repo, pull_number, batch);
    if (i + batchSize < comments.length) {
      console.log("Waiting for 3 seconds before sending the next batch...");
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
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
    await createReviewComments(
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
