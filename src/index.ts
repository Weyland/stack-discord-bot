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
const CHECK_INTERVAL = 5 * 60 * 1000;
const VERSION_FILE = "./data/versions.json";

type VersionMap = {
  images: Record<string, string>;
  announced: Record<string, boolean>;
};

let versionData: VersionMap = loadVersionData();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function loadVersionData(): VersionMap {
  try {
    return JSON.parse(fs.readFileSync(VERSION_FILE, "utf8"));
  } catch {
    return { images: {}, announced: {} };
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
  const tags: { tag: string; updated: string }[] = [];
  let page = 1;

  try {
    while (true) {
      const url = `https://hub.docker.com/v2/repositories/${image}/tags?page_size=100&page=${page}&ordering=last_updated`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Docker Hub error: ${res.statusText}`);
      const data = await res.json();

      for (const result of data.results) {
        tags.push({ tag: result.name, updated: result.last_updated });
      }

      if (!data.next) break;
      page++;
    }
  } catch (err) {
    console.warn(`⚠️ Docker Hub tag fetch failed for ${image}:`, err);
  }

  return tags;
}

function findLatestMatchingTag(
  tags: { tag: string; updated: string }[],
  baseTag: string
): string | null {
  const isLatestLike = baseTag === "latest" || baseTag.startsWith("latest");

  const semverTags = tags
    .map(({ tag, updated }) => ({
      tag,
      version: semver.coerce(tag),
      updated,
    }))
    .filter((t) => t.version !== null && !semver.prerelease(t.version!));

  if (isLatestLike) {
    const latestSemver = semverTags.sort(
      (a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime()
    )[0];
    return latestSemver?.tag || null;
  }

  const filtered = semverTags.filter(
    ({ tag }) =>
      tag.startsWith(baseTag + ".") ||
      tag === baseTag ||
      tag.startsWith(baseTag + "-")
  );

  const sorted = filtered.sort((a, b) =>
    semver.rcompare(a.version!, b.version!)
  );

  return sorted[0]?.tag || null;
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
