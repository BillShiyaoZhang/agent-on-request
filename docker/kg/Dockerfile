FROM node:26.10.0-bookworm-slim AS frontend
WORKDIR /ui
COPY --from=kg_source /console/package.json /console/package-lock.json ./
RUN npm ci
COPY --from=kg_source /console/ ./
RUN npm run build

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/plugins:/app
WORKDIR /app
COPY --from=kg_source /requirements-console.lock ./
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements-console.lock
COPY --from=kg_source /plugins/ plugins/
COPY --from=kg_source /scripts/ scripts/
COPY --from=kg_source /skills/ skills/
COPY --from=frontend /ui/dist /app/static
COPY docker/kg/server.py /demo/server.py
ENV KG_STATIC_DIR=/app/static KG_SYNC_SCHEDULER_ENABLED=false
EXPOSE 8765
CMD ["python", "/demo/server.py"]
