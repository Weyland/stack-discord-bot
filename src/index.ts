import {
  Client,
  GatewayIntentBits,
  TextChannel,
  EmbedBuilder,
} from "discord.js";
import fs from "fs";
import dotenv from "dotenv";
import { execSync } from "child_process";
import semver from "semver";

dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN!;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID!;
const DOCKER_HUB_USERNAME = process.env.DOCKER_HUB_USERNAME;
const DOCKER_HUB_TOKEN = process.env.DOCKER_HUB_TOKEN;

const CHECK_INTERVAL = 5 * 60 * 1000;
const VERSION_FILE = "./data/versions.json";

type VersionMap = {
  images: Record<string, string>;
  announced: Record<string, boolean>;
};

let versionData: VersionMap = loadVersionData();
const dockerHubCache: Record<string, { tag: string; updated: string }[]> = {};

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function loadVersionData(): VersionMap {
  try {
    return JSON.parse(fs.readFileSync(VERSION_FILE, "utf8"));
  } catch {
    return {
      images: {},
      announced: {},
    };
  }
}

function saveVersionData() {
  fs.writeFileSync(VERSION_FILE, JSON.stringify(versionData, null, 2), "utf8");
}

function getRunningDockerImages(): { image: string; tag: string }[] {
  try {
    const output = execSync(`docker ps --format "{{.Image}}"`, {
      encoding: "utf8",
    });
    const lines = output.split("\n").filter(Boolean);
    const uniqueImages = Array.from(new Set(lines));

    return uniqueImages.map((fullImage) => {
      const [image, tag = "latest"] = fullImage.split(":");
      return { image, tag };
    });
  } catch (err) {
    console.error("❌ Failed to list running Docker containers:", err);
    return [];
  }
}

function normalizeDockerHubName(image: string): string {
  return image.includes("/") ? image : `library/${image}`;
}

async function getMatchingLatestTag(
  image: string,
  baseTag: string
): Promise<string | null> {
  const allTags = await getAllDockerHubTags(normalizeDockerHubName(image));
  return findLatestMatchingTag(allTags, baseTag);
}

async function getAllDockerHubTags(
  image: string
): Promise<{ tag: string; updated: string }[]> {
  if (dockerHubCache[image]) {
    return dockerHubCache[image];
  }

  const tags: { tag: string; updated: string }[] = [];
  let page = 1;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (DOCKER_HUB_USERNAME && DOCKER_HUB_TOKEN) {
    const auth = Buffer.from(
      `${DOCKER_HUB_USERNAME}:${DOCKER_HUB_TOKEN}`
    ).toString("base64");
    headers["Authorization"] = `Basic ${auth}`;
  }

  try {
    while (true) {
      const url = `https://hub.docker.com/v2/repositories/${image}/tags?page_size=100&page=${page}&ordering=last_updated`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`Docker Hub error: ${res.statusText}`);
      const data = await res.json();

      for (const result of data.results) {
        tags.push({ tag: result.name, updated: result.last_updated });
      }

      if (!data.next) break;
      page++;
    }
    dockerHubCache[image] = tags;
  } catch (err) {
    console.warn(`⚠️ Docker Hub tag fetch failed for ${image}:`, err);
  }

  return tags;
}

function findLatestMatchingTag(
  tags: { tag: string; updated: string }[],
  baseTag: string
): string | null {
  const semverCandidates = tags
    .filter((t) => semver.valid(semver.coerce(t.tag)))
    .map((t) => ({
      tag: t.tag,
      version: semver.coerce(t.tag)!,
      updated: t.updated,
    }));

  if (baseTag === "latest") {
    const sorted = semverCandidates.sort((a, b) => {
      return new Date(b.updated).getTime() - new Date(a.updated).getTime();
    });
    return sorted.length > 0 ? sorted[0].tag : null;
  }

  const matching = semverCandidates
    .filter(
      (t) =>
        t.tag.startsWith(baseTag + ".") ||
        t.tag === baseTag ||
        t.tag.startsWith(baseTag + "-")
    )
    .sort((a, b) => semver.rcompare(a.version, b.version));

  return matching.length > 0 ? matching[0].tag : null;
}

async function checkForNewVersions() {
  const runningImages = getRunningDockerImages();
  const channel = (await client.channels.fetch(
    DISCORD_CHANNEL_ID
  )) as TextChannel;
  const embeds: EmbedBuilder[] = [];

  for (const { image, tag: runningTag } of runningImages) {
    try {
      const latest = await getMatchingLatestTag(image, runningTag);
      if (!latest) {
        console.warn(
          `⚠️ No matching latest tag found for ${image}:${runningTag}`
        );
        continue;
      }

      if (
        versionData.announced[image] &&
        versionData.images[image] === latest
      ) {
        continue;
      }

      if (runningTag !== latest) {
        const embed = new EmbedBuilder()
          .setColor("#ff9900")
          .setTitle(`Docker Image Update Available`)
          .setDescription(`**${image}** has a newer version available.`)
          .addFields(
            { name: "Current Tag", value: runningTag, inline: true },
            { name: "Latest Tag", value: latest, inline: true }
          )
          .setURL(`https://hub.docker.com/r/${image}`)
          .setTimestamp()
          .setFooter({ text: "Docker Version Checker" });

        embeds.push(embed);
      } else {
        console.log(`✅ ${image}:${runningTag} is up to date.`);
      }

      versionData.images[image] = latest;
      versionData.announced[image] = true;
      saveVersionData();
    } catch (err) {
      console.error(`❌ Error checking ${image}:`, (err as Error).message);
    }
  }

  if (embeds.length > 0) {
    const chunks = chunkArray(embeds, 10);
    for (const chunk of chunks) {
      await channel.send({ embeds: chunk });
    }
  }
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user?.tag}`);
  checkForNewVersions();
  setInterval(checkForNewVersions, CHECK_INTERVAL);
});

client.login(DISCORD_TOKEN);
