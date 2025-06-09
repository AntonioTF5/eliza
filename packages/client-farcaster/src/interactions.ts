import {
    composeContext,
    generateMessageResponse,
    generateShouldRespond,
    type Memory,
    ModelClass,
    stringToUuid,
    elizaLogger,
    type HandlerCallback,
    type Content,
    type IAgentRuntime,
} from "@elizaos/core";
import type { FarcasterClient } from "./client";
import { toHex } from "viem";
import { buildConversationThread, createCastMemory } from "./memory";
import type { Cast, Profile } from "./types";
import {
    formatCast,
    formatTimeline,
    messageHandlerTemplate,
    shouldRespondTemplate,
} from "./prompts";
import { castUuid } from "./utils";
import { sendCast } from "./actions";

export class FarcasterInteractionManager {
    private timeout: NodeJS.Timeout | undefined;
    private lastProcessedCasts: Set<string> = new Set();
    constructor(
        public client: FarcasterClient,
        public runtime: IAgentRuntime,
        private signerUuid: string,
        public cache: Map<string, any>
    ) {}

    public async start() {
        const handleInteractionsLoop = async () => {
            try {
                await this.handleInteractions();
            } catch (error) {
                elizaLogger.error(error);
            }

            // Always set up next check, even if there was an error
            this.timeout = setTimeout(
                handleInteractionsLoop,
                Number(this.client.farcasterConfig?.FARCASTER_POLL_INTERVAL ?? 120) *
                1000 // Default to 2 minutes
            );
        };

        handleInteractionsLoop();
    }

    public async stop() {
        if (this.timeout) clearTimeout(this.timeout);
    }

    private async handleInteractions() {
        elizaLogger.log("Checking Farcaster interactions");

        const agentFid = this.client.farcasterConfig?.FARCASTER_FID ?? 0;
        if (!agentFid) {
            elizaLogger.info("No FID found, skipping interactions");
            return;
        }

        // Get mentions for our agent
        const mentions = await this.client.getMentions({
            fid: agentFid,
            pageSize: 10,
        });

        // Store mentions
        let castsCandidates = [...mentions];

        if (this.client.farcasterConfig.FARCASTER_TARGET_USERS.length) {
            const TARGET_USERS = this.client.farcasterConfig.FARCASTER_TARGET_USERS;
            elizaLogger.log("Processing target users:", TARGET_USERS);

            if (TARGET_USERS.length > 0) {
                // Create a map to store casts by user
                const castsByUser = new Map<string, Cast[]>();

                // Fetch casts from all targer users
                for (const username of TARGET_USERS) {
                    try {
                        const userInfo = await this.client.neynar.lookupUserByUsername({
                            username: username,
                            viewerFid: agentFid
                        });

                        if (!userInfo.user) {
                            elizaLogger.error(`User ${username} not found`);
                            continue;
                        }

                        const userCasts = await this.client.neynar.fetchCastsForUser({
                            fid: userInfo.user.fid,
                            viewerFid: agentFid,
                            limit: 10, // TODO: make this configurable in .env
                            includeReplies: false
                        });

                        // Filter for unprocessed, non-reply, recent casts
                        const validCasts = userCasts.casts.filter((cast) => {
                            // Проверяем не обрабатывали ли мы уже этот каст
                            const isUnprocessed = !this.lastProcessedCasts.has(cast.hash);
                            
                            const isRecent = Date.now() - new Date(cast.timestamp).getTime() < 
                                24 * 60 * 60 * 1000; // 24 часа

                            elizaLogger.log(`Cast ${cast.hash} checks:`, {
                                isUnprocessed,
                                isRecent,
                                isReply: cast.parent_hash !== null,
                            });

                            return (
                                isUnprocessed && 
                                isRecent && 
                                cast.text.length > 10
                            );
                        });

                        const processedCasts: Cast[] = []

                        for (const cast of validCasts) {
                            const profile = await this.client.getProfile(cast.author.fid);

                            processedCasts.push({
                                hash: cast.hash,
                                authorFid: cast.author.fid,
                                text: cast.text,
                                profile: profile,
                                inReplyTo: cast.parent_hash ? {
                                    hash: cast.parent_hash,
                                    fid: cast.parent_author.fid
                                } : undefined,
                                timestamp: new Date(cast.timestamp)
                            })
                        }

                        if (processedCasts.length > 0) {
                            castsByUser.set(username, processedCasts);
                            elizaLogger.log(`Found ${processedCasts.length} valid casts from ${username}`, {
                                firstCast: validCasts[0].text.substring(0, 100),
                                isRecent: new Date(validCasts[0].timestamp).toISOString(),
                                isUnprocessed: !this.client.lastInteractionTimestamp
                            });
                        } else {
                            elizaLogger.log(`No valid casts found from ${username}`)
                        }
                    } catch (error) {
                        elizaLogger.error(`Error fetching casts for ${username}:`, error);
                        continue;
                    }
                }

                // Select one cast from each user that has casts
                const selectedCasts: Cast[] = [];
                for (const [username, casts] of castsByUser) {
                    if (casts.length > 0) {
                        const randomCast = casts[Math.floor(Math.random() * casts.length)];
                        selectedCasts.push(randomCast);
                        elizaLogger.log(`Selected cast from ${username}: ${randomCast.text.substring(0, 100)}`);
                    }
                }

                // Add selected casts to the list of candidates
                castsCandidates = [...mentions, ...selectedCasts];
            }
        }

        // Get our agent profile
        const agent = await this.client.getProfile(agentFid);

        for (const cast of castsCandidates) {
            const messageHash = toHex(cast.hash);
            const conversationId = `${messageHash}-${this.runtime.agentId}`;
            const roomId = stringToUuid(conversationId);
            const userId = stringToUuid(cast.authorFid.toString());

            const pastMemoryId = castUuid({
                agentId: this.runtime.agentId,
                hash: cast.hash,
            });

            const pastMemory =
                await this.runtime.messageManager.getMemoryById(pastMemoryId);

            if (pastMemory) {
                continue;
            }

            await this.runtime.ensureConnection(
                userId,
                roomId,
                cast.profile.username,
                cast.profile.name,
                "farcaster"
            );

            const thread = await buildConversationThread({
                client: this.client,
                runtime: this.runtime,
                cast: cast,
            });

            const memory: Memory = {
                content: { text: cast.text },
                agentId: this.runtime.agentId,
                userId,
                roomId,
            };

            await this.handleCast({
                agent,
                cast: cast,
                memory,
                thread,
            });
        }

        this.client.lastInteractionTimestamp = new Date();
        elizaLogger.log("Updated lastInteractionTimestamp:", this.client.lastInteractionTimestamp);
    }

    private async handleCast({
        agent,
        cast,
        memory,
        thread,
    }: {
        agent: Profile;
        cast: Cast;
        memory: Memory;
        thread: Cast[];
    }) {
        if (cast.profile.fid === agent.fid) {
            elizaLogger.info("skipping cast from bot itself", cast.hash);
            return;
        }

        if (!memory.content.text) {
            elizaLogger.info("skipping cast with no text", cast.hash);
            return { text: "", action: "IGNORE" };
        }

        const currentPost = formatCast(cast);

        const senderId = stringToUuid(cast.authorFid.toString());

        const { timeline } = await this.client.getTimeline({
            fid: agent.fid,
            pageSize: 10,
        });

        const formattedTimeline = formatTimeline(
            this.runtime.character,
            timeline
        );

        const formattedConversation = thread
            .map(
                (cast) => `@${cast.profile.username} (${new Date(
                    cast.timestamp
                ).toLocaleString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                    month: "short",
                    day: "numeric",
                })}):
                ${cast.text}`
            )
            .join("\n\n");

        const state = await this.runtime.composeState(memory, {
            farcasterUsername: agent.username,
            timeline: formattedTimeline,
            currentPost,
            formattedConversation,
        });

        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.farcasterShouldRespondTemplate ||
                this.runtime.character?.templates?.shouldRespondTemplate ||
                shouldRespondTemplate,
        });

        const memoryId = castUuid({
            agentId: this.runtime.agentId,
            hash: cast.hash,
        });

        const castMemory =
            await this.runtime.messageManager.getMemoryById(memoryId);

        if (!castMemory) {
            await this.runtime.messageManager.createMemory(
                createCastMemory({
                    roomId: memory.roomId,
                    senderId,
                    runtime: this.runtime,
                    cast,
                })
            );
        }

        const shouldRespondResponse = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.SMALL,
        });

        if (
            shouldRespondResponse === "IGNORE" ||
            shouldRespondResponse === "STOP"
        ) {
            elizaLogger.info(
                `Not responding to cast because generated ShouldRespond was ${shouldRespondResponse}`
            );
            return;
        }

        const context = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.farcasterMessageHandlerTemplate ??
                this.runtime.character?.templates?.messageHandlerTemplate ??
                messageHandlerTemplate,
        });

        const responseContent = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        responseContent.inReplyTo = memoryId;

        if (!responseContent.text) return;

        if (this.client.farcasterConfig?.FARCASTER_DRY_RUN) {
            elizaLogger.info(
                `Dry run: would have responded to cast ${cast.hash} with ${responseContent.text}`
            );
            return;
        }

        const callback: HandlerCallback = async (
            content: Content,
            _files: any[]
        ) => {
            try {
                if (memoryId && !content.inReplyTo) {
                    content.inReplyTo = memoryId;
                }
                const results = await sendCast({
                    runtime: this.runtime,
                    client: this.client,
                    signerUuid: this.signerUuid,
                    profile: cast.profile,
                    content: content,
                    roomId: memory.roomId,
                    inReplyTo: {
                        fid: cast.authorFid,
                        hash: cast.hash,
                    },
                });

                // Добавляем в lastProcessedCasts только после успешной отправки ответа
                this.lastProcessedCasts.add(cast.hash);

                // sendCast lost response action, so we need to add it back here
                results[0].memory.content.action = content.action;

                for (const { memory } of results) {
                    await this.runtime.messageManager.createMemory(memory);
                }
                return results.map((result) => result.memory);
            } catch (error) {
                elizaLogger.error("Error sending response cast:", error);
                return [];
            }
        };

        const responseMessages = await callback(responseContent);

        const newState = await this.runtime.updateRecentMessageState(state);

        await this.runtime.processActions(
            { ...memory, content: { ...memory.content, cast } },
            responseMessages,
            newState,
            callback
        );
    }
}
