FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY services/ml/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/ml/ ./
RUN mkdir -p /app/models /app/data
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
