# Meetly: a scheduling variant of Plow's OpenClaw base image.
# Local base tagged by its source commit; build it before building Meetly.
FROM plow-openclaw:base-5d4d2c6312f545b52de4de9e5b0b44020c7d5256

# New groups give guests only the scheduling tools; owners keep full tools.
ENV AGENT_ID=meetly \
    AGENT_NAME=Meetly \
    AGENT_BLURB="Your scheduling assistant. It reads your iMessages, spots who wants to meet, and opens a group to book it on your calendar. Or ask it to reach out to anyone for you. Works both ways." \
    AGENT_RUNTIME="OpenClaw 2.0" \
    PLOW_THREAD_TRUST=untrusted \
    PLOW_GUEST_TOOLS=meetly_view_request,meetly_pick_time,meetly_other_times,meetly_set_format,meetly_ask_owner,meetly_decline

COPY prompt/AGENTS.md /opt/plow/prompt/AGENTS.md
COPY skills/ /opt/plow/skills/

# Meetly's entrypoint: the base's boot step for step, plus the model (Plow's
# Luna by default, the owner's own OpenAI account after `plow-llm openai`),
# the setup gate plugin and the Mac relay's request timeout.
COPY boot/ /opt/meetly/boot/
COPY plugin/ /opt/meetly/plugin/
COPY boot/plow-llm.sh /usr/local/bin/plow-llm

CMD ["node", "/opt/meetly/boot/preboot.ts"]
