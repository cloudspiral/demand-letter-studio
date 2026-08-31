FROM public.ecr.aws/lambda/python:3.13
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt -t ${LAMBDA_TASK_ROOT}
COPY worker.py lambda_handler.py ${LAMBDA_TASK_ROOT}/
CMD ["lambda_handler.handler"]
