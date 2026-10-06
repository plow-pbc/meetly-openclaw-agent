# Meetly: a scheduling variant of Plow's OpenClaw base image.
FROM public.ecr.aws/e1h7x4a2/plow-cloud-agents@sha256:5b0ebf5e33514b09f0f22f1c14424a19b4eb3fc21adfaeb260002f76d362478c

# New groups give guests only the scheduling tools; owners keep full tools.
ENV AGENT_ID=meetly \
    AGENT_NAME=Meetly \
    AGENT_BLURB="Your scheduling assistant. It reads your iMessages, spots who wants to meet, and opens a group to book it on your calendar. Or ask it to reach out to anyone for you. Works both ways." \
    AGENT_RUNTIME="OpenClaw 2.0" \
    PLOW_THREAD_TRUST=untrusted \
    PLOW_GUEST_TOOLS=meetly_view_request,meetly_pick_time,meetly_other_times,meetly_set_format,meetly_ask_owner,meetly_decline

COPY prompt/AGENTS.md /opt/plow/prompt/AGENTS.md
COPY skills/ /opt/plow/skills/
COPY package.json package-lock.json /opt/plow/skills/
USER root
RUN npm ci --omit=dev --ignore-scripts --prefix /opt/plow/skills
USER node

# Meetly's entrypoint: the base's boot step for step, plus the setup gate
# plugin and the Mac relay's request timeout.
COPY boot/ /opt/meetly/boot/
COPY plugin/ /opt/meetly/plugin/

CMD ["node", "/opt/meetly/boot/preboot.ts"]
