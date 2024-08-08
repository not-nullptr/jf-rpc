import { Client } from "@xhayper/discord-rpc";
import { ActivityType } from "discord-api-types/v10";
import { Jellyfin } from "@jellyfin/sdk";
import dotenv from "dotenv";

dotenv.config();

import {
	getSessionApi,
	getSystemApi,
	getLyricsApi,
} from "@jellyfin/sdk/lib/utils/api";
import {
	BaseItemDto,
	LyricDto,
} from "@jellyfin/sdk/lib/generated-client/models";
import Filter from "bad-words";

const JELLYFIN_URL = process.env.JF_URL || "http://127.0.0.1:8096";

const cleanText = (text: string) => {
	const filter = new Filter({
		// the regex should match literally all characters, except the first and last character
		replaceRegex: /(?<=.).(?=.)/g,
		placeHolder: "*",
	});
	return filter.clean(text);
};

const jellyfin = new Jellyfin({
	clientInfo: {
		name: "JF-RPC",
		version: "1.0.0",
	},
	deviceInfo: {
		name: "Jellyfin RPC User",
		id: "jf-rpc-user",
	},
});

const api = jellyfin.createApi(JELLYFIN_URL);
api.accessToken = process.env.JF_ACCESS_TOKEN!;

const systemApi = getSystemApi(api);
const sessionApi = getSessionApi(api);
const lyricsApi = getLyricsApi(api);

systemApi
	.getSystemInfo()
	.then((i) => i.data)
	.then((i) =>
		console.log(
			`Connected to ${i.ServerName} running Jellyfin ${i.Version}`
		)
	);

const client = new Client({
	clientId: "1270817851648905367",
});

let currentSongId: string | null = null;
let album: BaseItemDto | undefined;
let artistUrl: string | undefined;
let lyrics: LyricDto | undefined;

let startTime: Date | null;
let endTime: Date | null;

const getCurrentLyric = (
	lyrics: LyricDto | undefined | null,
	playedTicks: number
) => {
	if (!lyrics || !lyrics.Lyrics) return "";
	return (
		lyrics.Lyrics?.find(
			(l) =>
				l ===
				lyrics.Lyrics?.filter((l) => (l.Start || 0) < playedTicks).at(
					-1
				)
		)?.Text || ""
	);
};

const renderPlaybar = (start: Date, end: Date, playedMs: number) => {
	// using ascii characters to render the playbar
	const playedBar = "⸗⸗";
	const unplayedBar = "⎯";
	const scrubber = "＠";
	const playbarLength = 10;

	const totalMs = end.getTime() - start.getTime();
	const played = playedMs || new Date().getTime() - start.getTime();

	const playedPercent = played / totalMs;

	const playedBarLength = Math.floor(playedPercent * playbarLength);
	const unplayedBarLength = playbarLength - playedBarLength;

	const playedBarString = playedBar.repeat(playedBarLength);
	const unplayedBarString = unplayedBar.repeat(unplayedBarLength);

	// return `${playedBarString}${scrubber}${unplayedBarString}`;

	// also surround it with time elapsed and total duration
	const minutes = Math.floor(played / 60000);
	const seconds = ((played % 60000) / 1000).toFixed(0);
	const totalMinutes = Math.floor(totalMs / 60000);
	const totalSeconds = ((totalMs % 60000) / 1000).toFixed(0);

	// return `${minutes}:${
	// 	+seconds < 10 ? "0" : ""
	// }${seconds} ${playedBarString}${scrubber}${unplayedBarString} ${totalMinutes}:${
	// 	+totalSeconds < 10 ? "0" : ""
	// }${totalSeconds}`;

	// the above but with the bug fixed where at minute turnover it shows 0:60 instead of 1:00
	return seconds === "60"
		? `${minutes + 1
		}:00 ${playedBarString}${scrubber}${unplayedBarString} ${totalMinutes}:00`
		: `${minutes}:${+seconds < 10 ? "0" : ""
		}${seconds} ${playedBarString}${scrubber}${unplayedBarString} ${totalMinutes}:${+totalSeconds < 10 ? "0" : ""
		}${totalSeconds}`;
};

const renderLargeText = (playbar: string, lyric: string) => {
	if (lyric.trim() !== "") {
		let result = `${playbar} • ${lyric}`;
		return cleanText(
			result.length > 128 ? `${result.slice(0, 128 - 3)}...` : result
		);
	} else {
		return playbar;
	}
};

client.on("ready", () => {
	setInterval(async () => {
		try {
			const session = (await sessionApi.getSessions()).data.find(
				(s) => s.UserId === process.env.JF_USER_ID
			);
			if (!session || session.PlayState?.IsPaused)
				throw new Error("No session found");

			if (currentSongId !== session.NowPlayingItem?.Id) {
				startTime = new Date();
				// converting ticks to seconds is n / 10000000
				endTime = new Date(
					startTime.getTime() +
					(session.NowPlayingItem?.RunTimeTicks || 0) / 10000
				);
				if (session.NowPlayingItem?.ParentId) {
					album = await fetch(
						`${JELLYFIN_URL}/Users/${process.env.JF_USER_ID}/Items/${session.NowPlayingItem.ParentId}`,
						{
							headers: {
								Authorization: `MediaBrowser Token=${api.accessToken}`,
							},
						}
					).then((r) => r.json());
				}

				if (album && album.ArtistItems?.[0]?.Id) {
					artistUrl = `${JELLYFIN_URL}/Items/${album.ArtistItems?.[0]?.Id}/Images/Primary?fillHeight=96&fillWidth=96&quality=100`;
				}
				if (session.NowPlayingItem?.Id) {
					lyrics = (
						await lyricsApi.getLyrics({
							itemId: session.NowPlayingItem.Id,
						})
					).data;
				}
			}

			currentSongId = session.NowPlayingItem?.Id || "";
			client.user?.setActivity({
				details: `${session.NowPlayingItem?.Artists?.map((a) => a).join(", ") ||
					"Unknown"
					} - ${session.NowPlayingItem?.Name || "Unknown"}`,
				state: session.NowPlayingItem?.Album || "Unknown",
				largeImageKey: `${JELLYFIN_URL}/Items/${session.NowPlayingItem?.ParentId}/Images/Primary?fillHeight=96&fillWidth=96&quality=100`,
				largeImageText:
					// get time left in mm:ss format
					startTime && endTime
						? `${renderLargeText(
							renderPlaybar(
								startTime,
								endTime,
								(session.PlayState?.PositionTicks || 1) /
								10000
							),
							getCurrentLyric(
								lyrics,
								session.PlayState?.PositionTicks || 1
							)
						)}`
						: "",
				smallImageKey: artistUrl,
				smallImageText: `${album?.Artists?.[0] || "Unknown Artist"
					} - jf-rpc written by nullptr`,
				instance: false,
				type: ActivityType.Listening,
			});
		} catch (e: any) {
			console.error(e);
			// client.user?.setActivity({});
		}
	}, 1000);
});

client.login();
