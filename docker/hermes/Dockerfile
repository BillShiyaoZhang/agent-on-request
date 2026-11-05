ARG HERMES_IMAGE=nousresearch/hermes-agent:v0.22.7
FROM ${HERMES_IMAGE}

# The official entrypoint seeds this template only when a profile has no config.
COPY docker/hermes/config.yaml /opt/hermes/cli-config.yaml.example
COPY docker/hermes/healthcheck.py /opt/hermes/demo-healthcheck.py
COPY docker/hermes/configure-profile.py /opt/hermes/configure-demo-profile.py
COPY docker/hermes/dashboard-forward.py /opt/hermes/demo-dashboard-forward.py
COPY --from=kg_source /plugins/kg /opt/demo-kg/plugins/kg
COPY --from=kg_source /skills/kg-memory /opt/demo-kg/skills/kg-memory
COPY --from=kg_source /skills/kg-memory-sync /opt/demo-kg/skills/kg-memory-sync
COPY docker/hermes/kg-proposal-policy.py /opt/demo-kg/plugins/kg/demo_policy.py
COPY docker/hermes/kg-plugin-entrypoint.py /opt/demo-kg/plugins/kg/__init__.py
RUN /opt/hermes/tools/uv-0.13.5-linux-x64/uv pip install \
      --python /opt/hermes/.venv/bin/python --target /opt/demo-kg/plugins/kg/_vendor \
      --require-hashes -r /opt/demo-kg/plugins/kg/requirements.lock
RUN mkdir -p /opt/hermes/demo-empty-bundled-plugins
RUN mkdir -p /etc/s6-overlay/s6-rc.d/dashboard-forward/dependencies.d \
    && printf 'longrun\n' > /etc/s6-overlay/s6-rc.d/dashboard-forward/type \
    && touch /etc/s6-overlay/s6-rc.d/dashboard-forward/dependencies.d/base \
    && touch /etc/s6-overlay/s6-rc.d/user/contents.d/dashboard-forward \
    && printf '#!/command/with-contenv sh\nexec s6-setuidgid hermes /opt/hermes/.venv/bin/python /opt/hermes/demo-dashboard-forward.py\n' \
      > /etc/s6-overlay/s6-rc.d/dashboard-forward/run \
    && chmod +x /etc/s6-overlay/s6-rc.d/dashboard-forward/run

ENV API_SERVER_ENABLED=true \
    API_SERVER_HOST=0.0.0.0 \
    API_SERVER_PORT=8642 \
    HERMES_DASHBOARD=1 \
    HERMES_DASHBOARD_HOST=127.0.0.1 \
    HERMES_DASHBOARD_PORT=9119 \
    DEMO_DASHBOARD_FORWARD_PORT=9129 \
    HERMES_BUNDLED_PLUGINS=/opt/hermes/demo-empty-bundled-plugins \
    HERMES_DISABLE_LAZY_INSTALLS=1 \
    NO_PROXY=127.0.0.1,localhost \
    no_proxy=127.0.0.1,localhost

EXPOSE 8642 9129
HEALTHCHECK --interval=3s --timeout=3s --start-period=20s --retries=20 \
    CMD ["/opt/hermes/.venv/bin/python", "/opt/hermes/demo-healthcheck.py"]
ENTRYPOINT ["/opt/hermes/.venv/bin/python", "/opt/hermes/configure-demo-profile.py"]
CMD ["gateway", "run"]
