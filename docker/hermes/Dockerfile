ARG HERMES_IMAGE=nousresearch/hermes-agent:v0.22.7
FROM ${HERMES_IMAGE}

# The official entrypoint seeds this template only when a profile has no config.
COPY config.yaml /opt/hermes/cli-config.yaml.example
COPY healthcheck.py /opt/hermes/demo-healthcheck.py
COPY configure-profile.py /opt/hermes/configure-demo-profile.py
RUN mkdir -p /opt/hermes/demo-empty-bundled-plugins

ENV API_SERVER_ENABLED=true \
    API_SERVER_HOST=0.0.0.0 \
    API_SERVER_PORT=8642 \
    HERMES_DASHBOARD=0 \
    HERMES_BUNDLED_PLUGINS=/opt/hermes/demo-empty-bundled-plugins \
    HERMES_DISABLE_LAZY_INSTALLS=1 \
    NO_PROXY=127.0.0.1,localhost \
    no_proxy=127.0.0.1,localhost

EXPOSE 8642
HEALTHCHECK --interval=3s --timeout=3s --start-period=20s --retries=20 \
    CMD ["/opt/hermes/.venv/bin/python", "/opt/hermes/demo-healthcheck.py"]
ENTRYPOINT ["/opt/hermes/.venv/bin/python", "/opt/hermes/configure-demo-profile.py"]
CMD ["gateway", "run"]
